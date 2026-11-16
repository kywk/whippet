//go:build integration

package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func m12ReadAuthorBudget(t *testing.T, f m10PartialFixture, run string) AuthorInput {
	t.Helper()
	var raw []byte
	if err := f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload FROM runs WHERE id=$1`, run).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var input AuthorInput
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func m12ContinueAndClaim(t *testing.T, f m10PartialFixture) m10PartialFixture {
	t.Helper()
	if err := f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
		t.Fatal(err)
	}
	results := make([]AuthorSubmission, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = f.p.ContinueAuthor(f.ctx, f.assignment.ID, f.sessionID, f.revision)
		}(i)
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil || results[0].Run.ID != results[1].Run.ID {
		t.Fatal("CAS duplicate continuation", errs)
	}
	next, err := f.p.Claim(f.ctx, "m10-partial", 1)
	if err != nil || next == nil || next.ID != results[0].Run.ID {
		t.Fatal("claim", err)
	}
	f.assignment = next
	return f
}

func TestM12ContinuationPostgresSharedBudgetCASAndReplay(t *testing.T) {
	m10SkillRoot(t)
	f := setupM10Partial(t)
	rootID := f.assignment.ID
	root := m12ReadAuthorBudget(t, f, rootID)
	for ordinal := 1; ordinal <= 3; ordinal++ {
		currentID := f.assignment.ID
		input := m12ReadAuthorBudget(t, f, currentID)
		if input.Budget.MaxModelRequests != root.Budget.MaxModelRequests-(ordinal-1)*2 || input.Budget.MaxToolCalls != root.Budget.MaxToolCalls-(ordinal-1)*3 || input.Budget.MaxDurationMS != root.Budget.MaxDurationMS-(ordinal-1)*1000 || *input.Runtime != *root.Runtime {
			t.Fatal("runtime/budget reset")
		}
		f.finish(t, nil, "succeeded", &AuthorUsage{2, 3, 1000})
		if _, err := f.p.ContinueAuthor(f.ctx, currentID, f.sessionID, f.revision); !errors.Is(err, ErrConflict) {
			t.Fatal("allowed before reclaim", err)
		}
		if ordinal < 3 {
			f = m12ContinueAndClaim(t, f)
			continue
		}
		if err := f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := f.p.ContinueAuthor(f.ctx, currentID, f.sessionID, f.revision); !errors.Is(err, ErrContinuationBudget) {
			t.Fatal("fourth Run allowed", err)
		}
	}
	// Replaying an old source after the chain cap does not charge or mutate again.
	replay, err := f.p.ContinueAuthor(f.ctx, rootID, f.sessionID, f.revision)
	if err != nil || replay.Run.ID == f.assignment.ID {
		t.Fatal("old source replay", err)
	}
	var count int
	if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM author_chain_budgets WHERE root_run_id=$1`, rootID).Scan(&count); err != nil || count != 3 {
		t.Fatal("duplicate reservation", err)
	}
	if _, err = f.p.DB.ExecContext(f.ctx, `UPDATE author_chain_budgets SET spent_before='{"modelRequests":0,"toolCalls":0,"durationMs":0}' WHERE run_id=$1`, f.assignment.ID); err == nil {
		t.Fatal("immutable chain budget changed")
	}
}

func TestM12ContinuationPostgresExhaustionMissingUsageAndRollback(t *testing.T) {
	m10SkillRoot(t)
	for _, name := range []string{"models", "duration", "missing", "invalid"} {
		t.Run(name, func(t *testing.T) {
			f := setupM10Partial(t)
			budget := f.assignment.Author.Budget
			u := &AuthorUsage{1, 0, 1}
			switch name {
			case "models":
				u.ModelRequests = budget.MaxModelRequests
			case "duration":
				u.DurationMS = budget.MaxDurationMS
			case "missing":
				u = nil
			case "invalid":
				u.ModelRequests = budget.MaxModelRequests + 1
			}
			f.finish(t, nil, "succeeded", u)
			if err := f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
				t.Fatal(err)
			}
			before, _ := f.p.EditingSession(f.ctx, f.testID, f.sessionID)
			_, err := f.p.ContinueAuthor(f.ctx, f.assignment.ID, f.sessionID, f.revision)
			if name == "invalid" {
				if !errors.Is(err, ErrConflict) {
					t.Fatal("invalid usage still eligible", err)
				}
			} else if !errors.Is(err, ErrContinuationBudget) {
				t.Fatal("exhausted chain continued", err)
			}
			after, _ := f.p.EditingSession(f.ctx, f.testID, f.sessionID)
			if before.ContextRevision != after.ContextRevision {
				t.Fatal("rejected continuation advanced CAS")
			}
			var count int
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM runs WHERE test_id=$1`, f.testID).Scan(&count); err != nil || count != 1 {
				t.Fatal("rejected continuation leaked Run", err)
			}
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			engine := NewEngine(f.p, logger)
			defer engine.Close()
			handler := NewAPI(f.p, f.files, engine, "synthetic-manager", logger).Handler(nil)
			request := httptest.NewRequest("POST", "http://server/api/runs/"+f.assignment.ID+"/continue", strings.NewReader(jsonText(map[string]any{"editingSessionId": f.sessionID, "revision": f.revision})))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 409 || name != "invalid" && !strings.Contains(response.Body.String(), "continuation_budget_exhausted") {
				t.Fatal("budget error response", response.Code)
			}
		})
	}
}

func TestM12ContinuationPostgresLegacyFailsClosedAndToolsCannotReset(t *testing.T) {
	m10SkillRoot(t)
	f := setupM10Partial(t)
	u := &AuthorUsage{1, f.assignment.Author.Budget.MaxToolCalls, 1}
	f.finish(t, nil, "succeeded", u)
	f = m12ContinueAndClaim(t, f)
	if f.assignment.Author.Budget.MaxToolCalls != 0 {
		t.Fatal("tool quota reset")
	}
	f.finish(t, nil, "succeeded", &AuthorUsage{0, 0, 1})
	if err := f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
		t.Fatal(err)
	}
	legacy := NewID()
	_, err := f.p.DB.ExecContext(f.ctx, `INSERT INTO runs(id,test_id,workspace_id,editing_session_id,kind,status,slot_released,author_partial,author_partial_context_revision,author_payload,draft_revision,script_snapshot,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,author_engine)
 SELECT $2,test_id,workspace_id,editing_session_id,kind,status,slot_released,author_partial,author_partial_context_revision,author_payload,draft_revision,script_snapshot,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,author_engine FROM runs WHERE id=$1`, f.assignment.ID, legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.p.ContinueAuthor(f.ctx, legacy, f.sessionID, f.revision); !errors.Is(err, ErrContinuationUsage) {
		t.Fatal("legacy missing policy gained a fresh budget", err)
	}
}
