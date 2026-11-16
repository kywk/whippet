package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
)

var ErrContinuationBudget = errors.New("continuation_budget_exhausted")
var ErrContinuationUsage = errors.New("continuation_usage_unavailable")

// Worker-owned counters, never model-reported tokens or a monetary invoice.
// A missing receipt consumes the entire allocation; it cannot mint new credit.
type AuthorUsage struct {
	ModelRequests int `json:"modelRequests"`
	ToolCalls     int `json:"toolCalls"`
	DurationMS    int `json:"durationMs"`
}

func (u *AuthorUsage) UnmarshalJSON(raw []byte) error {
	if strictJSONNoDuplicates(raw) != nil || !requiredJSONFields(raw, "modelRequests", "toolCalls", "durationMs") {
		return ErrInvalid
	}
	type plain AuthorUsage
	var value plain
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&value) != nil || d.Decode(new(any)) != io.EOF || value.ModelRequests < 0 || value.ToolCalls < 0 || value.DurationMS < 0 {
		return ErrInvalid
	}
	*u = AuthorUsage(value)
	return nil
}

func validAuthorUsage(u *AuthorUsage, budget *AuthorBudget) bool {
	return u != nil && budget != nil && u.ModelRequests >= 0 && u.ModelRequests <= budget.MaxModelRequests &&
		u.ToolCalls >= 0 && u.ToolCalls <= budget.MaxToolCalls && u.DurationMS >= 1 && u.DurationMS <= budget.MaxDurationMS
}

type authorChainBudget struct {
	RootRunID string
	Ordinal   int
	MaxRuns   int
	Limit     AuthorBudget
	Spent     AuthorUsage
}

func (c authorChainBudget) remaining() (AuthorBudget, error) {
	b := c.Limit
	if !ValidID(c.RootRunID) || c.MaxRuns != 3 || c.Ordinal < 1 || c.Ordinal > c.MaxRuns ||
		b.MaxModelRequests < 1 || b.MaxToolCalls < 0 || b.MaxDurationMS < 1 ||
		c.Spent.ModelRequests < 0 || c.Spent.ToolCalls < 0 || c.Spent.DurationMS < 0 ||
		c.Spent.ModelRequests > b.MaxModelRequests || c.Spent.ToolCalls > b.MaxToolCalls || c.Spent.DurationMS > b.MaxDurationMS {
		return AuthorBudget{}, ErrContinuationUsage
	}
	b.MaxModelRequests -= c.Spent.ModelRequests
	b.MaxToolCalls -= c.Spent.ToolCalls
	b.MaxDurationMS -= c.Spent.DurationMS
	return b, nil
}

func nextAuthorChainBudget(c authorChainBudget, input AuthorInput, usage *AuthorUsage) (*authorChainBudget, error) {
	remaining, err := c.remaining()
	if err != nil || input.Budget == nil {
		return nil, ErrContinuationUsage
	}
	b := input.Budget
	if b.MaxModelRequests > remaining.MaxModelRequests || b.MaxToolCalls > remaining.MaxToolCalls || b.MaxDurationMS > remaining.MaxDurationMS || effectiveOutputTokens(b) > effectiveOutputTokens(&c.Limit) {
		return nil, ErrContinuationUsage
	}
	charged := AuthorUsage{b.MaxModelRequests, b.MaxToolCalls, b.MaxDurationMS}
	if usage != nil {
		if !validAuthorUsage(usage, b) {
			return nil, ErrContinuationUsage
		}
		charged = *usage
	}
	// Bound before adding, so even corrupt stored counters cannot overflow.
	if charged.ModelRequests > remaining.MaxModelRequests || charged.ToolCalls > remaining.MaxToolCalls || charged.DurationMS > remaining.MaxDurationMS {
		return nil, ErrContinuationUsage
	}
	c.Spent.ModelRequests += charged.ModelRequests
	c.Spent.ToolCalls += charged.ToolCalls
	c.Spent.DurationMS += charged.DurationMS
	remaining, err = c.remaining()
	if err != nil {
		return nil, err
	}
	if c.Ordinal >= c.MaxRuns || remaining.MaxModelRequests < 1 || remaining.MaxDurationMS < 1 {
		return nil, ErrContinuationBudget
	}
	c.Ordinal++
	return &c, nil
}

func effectiveOutputTokens(b *AuthorBudget) int {
	if b.MaxOutputTokens == nil {
		return 8192
	}
	return *b.MaxOutputTokens
}

func (c authorChainBudget) constrain(input *AuthorInput) error {
	remaining, err := c.remaining()
	if err != nil || input.Budget == nil || remaining.MaxModelRequests < 1 || remaining.MaxDurationMS < 1 {
		return ErrContinuationBudget
	}
	b := *input.Budget
	b.MaxModelRequests = min(b.MaxModelRequests, remaining.MaxModelRequests)
	b.MaxToolCalls = min(b.MaxToolCalls, remaining.MaxToolCalls)
	b.MaxDurationMS = min(b.MaxDurationMS, remaining.MaxDurationMS)
	// The public Module author route stages body/harness and commits in three
	// calls. Do not queue a child that cannot produce one complete candidate.
	if standaloneModule(*input) && (b.MaxModelRequests < 3 || b.MaxToolCalls < 3) {
		return ErrContinuationBudget
	}
	output := min(effectiveOutputTokens(&b), effectiveOutputTokens(&c.Limit))
	if output != 8192 || b.MaxOutputTokens != nil || c.Limit.MaxOutputTokens != nil {
		b.MaxOutputTokens = &output
	}
	input.Budget = &b
	return nil
}

func readAuthorChainBudget(ctx context.Context, tx *sql.Tx, source string) (authorChainBudget, error) {
	var c authorChainBudget
	var limit, spent []byte
	err := tx.QueryRowContext(ctx, `SELECT root_run_id,ordinal,max_runs,budget_limit,spent_before FROM author_chain_budgets WHERE run_id=$1`, source).
		Scan(&c.RootRunID, &c.Ordinal, &c.MaxRuns, &limit, &spent)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrContinuationUsage
	}
	if err != nil {
		return c, err
	}
	if json.Unmarshal(limit, &c.Limit) != nil || json.Unmarshal(spent, &c.Spent) != nil {
		return c, ErrContinuationUsage
	}
	_, err = c.remaining()
	return c, err
}

func saveAuthorChainBudget(ctx context.Context, tx *sql.Tx, runID string, input AuthorInput, chain *authorChainBudget) error {
	if input.SkillID != "test-author" && !standaloneModule(input) {
		return nil
	}
	if chain == nil {
		if input.Budget == nil {
			return ErrContinuationUsage
		}
		chain = &authorChainBudget{RootRunID: runID, Ordinal: 1, MaxRuns: 3, Limit: *input.Budget}
	}
	if _, err := chain.remaining(); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO author_chain_budgets(run_id,root_run_id,ordinal,max_runs,budget_limit,spent_before) VALUES($1,$2,$3,$4,$5,$6)`,
		runID, chain.RootRunID, chain.Ordinal, chain.MaxRuns, jsonText(chain.Limit), jsonText(chain.Spent))
	return err
}
