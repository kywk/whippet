package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type PlanSummaryCandidate struct {
	TestID     string `json:"testId"`
	VersionID  string `json:"versionId"`
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	ModuleKind string `json:"moduleKind"`
	Revision   int    `json:"revision"`
	BundleHash string `json:"bundleHash"`
}
type PlanSummary struct {
	RunID             string                 `json:"runId"`
	PlanID            string                 `json:"planId"`
	PlanRevision      int                    `json:"planRevision"`
	BatchHash         string                 `json:"batchHash"`
	Status            string                 `json:"status"`
	Stale             bool                   `json:"stale"`
	PublishReady      bool                   `json:"publishReady"`
	Message           *string                `json:"message"`
	Description       *string                `json:"description"`
	BackgroundSummary *string                `json:"backgroundSummary"`
	Name              *string                `json:"name"`
	Candidates        []PlanSummaryCandidate `json:"candidates"`
}

func (p *Postgres) CreatePlanSummary(ctx context.Context, id string, revision int, validation string) (Run, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	plan, d, s, err := lockPlan(ctx, tx, id)
	if err != nil {
		return Run{}, err
	}
	if plan.Revision != revision || plan.ValidationRunID == nil || *plan.ValidationRunID != validation {
		return Run{}, ErrConflict
	}
	batch, err := p.buildPlanBatch(ctx, tx, plan, d, s)
	if err != nil {
		return Run{}, err
	}
	var existing string
	err = tx.QueryRowContext(ctx, `SELECT r.id FROM plan_summaries ps JOIN runs r ON r.id=ps.run_id WHERE ps.plan_id=$1 AND ps.batch_hash=$2 AND (r.status='succeeded' OR r.status IN ('queued','dispatched','running','collecting')) ORDER BY r.created_at DESC LIMIT 1`, id, batch.BatchHash).Scan(&existing)
	if err == nil {
		return scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, existing))
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Run{}, err
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE editing_session_id=$1 AND kind='author' AND (status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted') OR NOT slot_released))`, s.ID).Scan(&active); err != nil {
		return Run{}, err
	}
	if active {
		return Run{}, ErrConflict
	}
	input := editingAuthorInput(s, d, "acceptance-summary", []ChatMessage{{Role: "user", Content: "Summarize this verified Use Case and the complete reused/new/modified Module batch, including coverage and limitations. Do not claim untested behavior."}})
	input.Batch = batch
	input.ValidationEvidence = &batch.UseCase.ValidationEvidence
	run, err := enqueueAuthor(ctx, tx, d, input)
	if err != nil {
		return Run{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO plan_summaries(run_id,plan_id,batch_hash) VALUES($1,$2,$3)`, run.ID, id, batch.BatchHash); err != nil {
		return Run{}, err
	}
	return run, tx.Commit()
}
func (p *Postgres) completePlanSummary(ctx context.Context, tx *sql.Tx, run, attempt string, input AuthorInput, d draftState, s EditingSession, externalOutput []byte) error {
	if input.Batch == nil || input.SkillID != "acceptance-summary" || input.Platform != nil || len(input.AllowedTools) != 0 {
		return ErrInvalid
	}
	plan, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1 AND test_id=$2 FOR UPDATE`, input.Batch.PlanID, d.TestID))
	if err != nil {
		return err
	}
	current, err := p.buildPlanBatch(ctx, tx, plan, d, s)
	if err != nil {
		return err
	}
	hash, err := input.Batch.hash()
	if err != nil || hash != input.Batch.BatchHash || hash != current.BatchHash {
		return ErrConflict
	}
	data := externalOutput
	if data == nil {
		data, err = p.readArtifactBytes(ctx, tx, run, attempt, "author.json", MaxAuthorArtifactBytes)
		if err != nil {
			return err
		}
	}
	var out summaryOutput
	if externalOutput != nil {
		out, err = decodeExternalSummaryOutput(data)
	} else {
		out, err = decodeSummaryOutput(data)
	}
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE plan_summaries SET output=$2 WHERE run_id=$1 AND plan_id=$3 AND batch_hash=$4 AND output IS NULL`, run, jsonText(out), plan.ID, hash)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return ErrConflict
	}
	return nil
}
func (p *Postgres) PlanSummary(ctx context.Context, id string) (*PlanSummary, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Deliberately not lockPlan: GET must not reconcile or mutate Plan state.
	plan, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1`, id))
	if err != nil {
		return nil, err
	}
	var raw, output []byte
	var run, status string
	var released bool
	err = tx.QueryRowContext(ctx, `SELECT r.id,r.status,r.slot_released,r.author_payload,ps.output FROM plan_summaries ps JOIN runs r ON r.id=ps.run_id WHERE ps.plan_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`, id).Scan(&run, &status, &released, &raw, &output)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var input AuthorInput
	if json.Unmarshal(raw, &input) != nil || input.Batch == nil {
		return nil, ErrConflict
	}
	batch := input.Batch
	result := &PlanSummary{RunID: run, PlanID: id, PlanRevision: batch.PlanRevision, BatchHash: batch.BatchHash, Status: status, Stale: true, Candidates: []PlanSummaryCandidate{}}
	for _, m := range batch.Modules {
		if m.Mode == "candidate" {
			result.Candidates = append(result.Candidates, PlanSummaryCandidate{m.TestID, m.VersionID, m.Name, m.Module.Slug, m.Module.ModuleKind, m.Revision, m.BundleHash})
		}
	}
	if status == "succeeded" && len(output) > 0 {
		var out summaryOutput
		if json.Unmarshal(output, &out) != nil {
			return nil, ErrConflict
		}
		result.Message = &out.Message
		result.Description = &out.Description
		result.BackgroundSummary = &out.BackgroundSummary
		result.Name = out.Name
	}
	d, s, err := requireEditingDraft(ctx, tx, plan.TestID, plan.EditingSessionID)
	if err == nil {
		current, e := p.buildPlanBatch(ctx, tx, plan, d, s)
		if e == nil {
			hash, e := batch.hash()
			result.Stale = e != nil || hash != batch.BatchHash || current.BatchHash != hash
		}
	}
	result.PublishReady = status == "succeeded" && !result.Stale && released && result.Description != nil && plan.Status == "composed"
	return result, nil
}
