package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// Called inside the author completion transaction, after the live attempt lock.
// Only saved canonical stages are used; the artifact supplies no editable Plan.
func (p *Postgres) completePlanner(ctx context.Context, tx *sql.Tx, run, attempt string, input AuthorInput, d draftState, session EditingSession) error {
	var kind string
	if err := tx.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, d.TestID).Scan(&kind); err != nil {
		return err
	}
	if validateAuthorPlatform(input, kind) != nil || input.EditingSessionID != session.ID || input.BaseRevision != d.Revision || input.ContextRevision != session.ContextRevision {
		return ErrConflict
	}
	registry, err := loadToolRegistry()
	if err != nil {
		return err
	}
	data, err := p.readArtifactBytes(ctx, tx, run, attempt, "author.json", MaxAuthorArtifactBytes)
	if err != nil {
		return err
	}
	out, err := decodePlannerAuthorOutput(data, input, registry)
	if err != nil {
		return err
	}
	var ref, hash string
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT id,content_hash,stages FROM plan_candidates WHERE run_id=$1 AND attempt_id=$2 AND editing_session_id=$3 AND base_revision=$4 AND context_revision=$5 ORDER BY sequence DESC LIMIT 1`, run, attempt, session.ID, input.BaseRevision, input.ContextRevision).Scan(&ref, &hash, &raw)
	if err != nil || ref != out.PlanCandidate.CandidateRef {
		return ErrConflict
	}
	var stages []PlanStageInput
	if json.Unmarshal(raw, &stages) != nil {
		return ErrInvalid
	}
	canonical, err := json.Marshal(stages)
	if err != nil || scriptHash(string(canonical)) != hash {
		return ErrInvalid
	}
	current, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE editing_session_id=$1 FOR UPDATE`, session.ID))
	id := NewID()
	revision := 1
	if errors.Is(err, ErrNotFound) {
		if input.Platform.PlanID != nil {
			return ErrConflict
		}
	} else if err != nil {
		return err
	} else {
		if input.Platform.PlanID == nil || *input.Platform.PlanID != current.ID || (current.Status != "draft" && current.Status != "stopped") {
			return ErrConflict
		}
		id = current.ID
		revision = current.Revision + 1
	}
	prepared, err := preparePlanStages(ctx, tx, session.WorkspaceID, stages)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO plans(id,test_id,editing_session_id,revision,base_revision,context_revision,status,stages) VALUES($1,$2,$3,$4,$5,$6,'draft',$7) ON CONFLICT(editing_session_id) DO UPDATE SET revision=EXCLUDED.revision,base_revision=EXCLUDED.base_revision,context_revision=EXCLUDED.context_revision,status='draft',stages=EXCLUDED.stages,validation_run_id=NULL,error=NULL`, id, d.TestID, session.ID, revision, d.Revision, session.ContextRevision+1, jsonText(prepared)); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id,base_revision) VALUES($1,$2,'assistant',$3,$4,$5)`, NewID(), session.ConversationID, *out.Message, run, input.BaseRevision); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET context_revision=context_revision+1,conversation_summary=COALESCE($2,conversation_summary) WHERE id=$1`, session.ID, out.ConversationSummary); err != nil {
		return err
	}
	return clearDraftSummary(ctx, tx, d.TestID)
}
