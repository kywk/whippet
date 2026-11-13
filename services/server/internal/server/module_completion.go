package server

import (
	"context"
	"database/sql"
	"errors"
)

func (p *Postgres) completeModule(ctx context.Context, tx *sql.Tx, run, attempt string, input AuthorInput, d draftState, session EditingSession) error {
	var kind, slug string
	if err := tx.QueryRowContext(ctx, `SELECT kind,slug FROM tests WHERE id=$1`, d.TestID).Scan(&kind, &slug); err != nil {
		return err
	}
	if validateAuthorPlatform(input, kind) != nil || input.Platform.Module.Slug != slug || input.EditingSessionID != session.ID || input.BaseRevision != d.Revision || input.ContextRevision != session.ContextRevision {
		return ErrConflict
	}
	if input.Platform.PlanID != nil {
		plan, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1`, *input.Platform.PlanID))
		if err != nil || plan.Status != "running" {
			return ErrConflict
		}
		bound := false
		for _, stage := range plan.Stages {
			if stage.ID == *input.Platform.StageID && stage.ModuleTestID == d.TestID && stage.Status == "authoring" && stage.AuthorRunID != nil && *stage.AuthorRunID == run {
				bound = true
			}
		}
		if !bound {
			return ErrConflict
		}
	}
	registry, err := loadToolRegistry()
	if err != nil {
		return err
	}
	data, err := p.readArtifactBytes(ctx, tx, run, attempt, "author.json", MaxModuleAuthorArtifactBytes)
	if err != nil {
		return err
	}
	out, err := decodeModuleAuthorOutput(data, input, registry)
	if err != nil {
		return err
	}
	module, stages := platformJSON(out.Module, nil)
	next := d.Revision + 1
	if _, err = tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,module,stages) VALUES($1,$2,$3,$4,$5,$6,$7,'ai',$8,$9)`, d.TestID, next, *out.Script, scriptHash(*out.Script), d.timeoutMS, settingsJSON(d.WorkspaceSettings), jsonText(d.WorkspaceContext), module, stages); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE drafts SET current_revision=$2,validation_run_id=NULL,summary_run_id=NULL,summary_description=NULL,summary_background=NULL,summary_name=NULL,updated_at=now() WHERE test_id=$1`, d.TestID, next); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id,base_revision,applied_revision) VALUES($1,$2,'assistant',$3,$4,$5,$6)`, NewID(), session.ConversationID, *out.Message, run, input.BaseRevision, next); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET context_revision=context_revision+1,conversation_summary=COALESCE($2,conversation_summary) WHERE id=$1`, session.ID, out.ConversationSummary); err != nil {
		return err
	}
	if input.Platform.PlanID != nil {
		applied, err := scanDraft(tx.QueryRowContext(ctx, draftSelect, d.TestID))
		if err != nil {
			return err
		}
		bundle, err := bundleForDraft(ctx, tx, applied)
		if err != nil {
			return err
		}
		hash, err := bundle.hash()
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO plan_module_candidates(id,plan_id,stage_id,source_run_id,test_id,editing_session_id,revision,context_revision,bundle_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, NewID(), *input.Platform.PlanID, *input.Platform.StageID, run, d.TestID, session.ID, next, session.ContextRevision+1, hash); err != nil {
			return err
		}
	}
	if *out.RequestValidation || input.Platform.PlanID != nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO module_validation_requests(source_run_id,test_id,editing_session_id,revision,context_revision) VALUES($1,$2,$3,$4,$5)`, run, d.TestID, session.ID, next, session.ContextRevision+1)
	}
	return err
}

// Separate transactions preserve the Workspace/Test/Draft/Run lock order. A
// heartbeat releases slots first; requests remain durable if scheduling retries.
func (p *Postgres) scheduleReclaimedModuleValidations(ctx context.Context) error {
	rows, err := p.DB.QueryContext(ctx, `SELECT q.source_run_id,q.test_id,q.editing_session_id FROM module_validation_requests q JOIN runs r ON r.id=q.source_run_id WHERE NOT q.resolved AND r.slot_released AND r.status='succeeded' ORDER BY q.source_run_id`)
	if err != nil {
		return err
	}
	type target struct{ run, test, session string }
	var pending []target
	for rows.Next() {
		var item target
		if err = rows.Scan(&item.run, &item.test, &item.session); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range pending {
		if err = p.scheduleModuleValidation(ctx, item.run, item.test, item.session); err != nil {
			return err
		}
	}
	return nil
}
func (p *Postgres) scheduleModuleValidation(ctx context.Context, run, test, session string) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	d, s, scopeErr := requireEditingDraft(ctx, tx, test, session)
	if scopeErr != nil && !errors.Is(scopeErr, ErrConflict) && !errors.Is(scopeErr, ErrNotFound) {
		return scopeErr
	}
	var revision int
	var contextRevision int64
	var resolved, released bool
	var status string
	var planActive bool
	if err = tx.QueryRowContext(ctx, `SELECT q.revision,q.context_revision,q.resolved,r.slot_released,r.status, CASE WHEN r.author_payload->'platform'->>'planId' IS NULL THEN true ELSE EXISTS(SELECT 1 FROM plans p WHERE p.id::text=r.author_payload->'platform'->>'planId' AND p.status='running' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.stages) stage WHERE stage->>'id'=r.author_payload->'platform'->>'stageId' AND stage->>'authorRunId'=r.id::text AND stage->>'status'='authoring')) END FROM module_validation_requests q JOIN runs r ON r.id=q.source_run_id WHERE q.source_run_id=$1 FOR UPDATE OF q,r`, run).Scan(&revision, &contextRevision, &resolved, &released, &status, &planActive); err != nil {
		return err
	}
	if resolved || !released || status != "succeeded" {
		return nil
	}
	var validation *string
	if planActive && scopeErr == nil && d.Revision == revision && s.ContextRevision == contextRevision {
		if _, err = tx.ExecContext(ctx, "SAVEPOINT module_validation"); err != nil {
			return err
		}
		queued, e := enqueueValidation(ctx, tx, d)
		if e != nil {
			if !errors.Is(e, ErrScopeConfirmation) && !errors.Is(e, ErrConflict) {
				return e
			}
			if _, err = tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT module_validation"); err != nil {
				return err
			}
		} else {
			validation = &queued.ID
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE module_validation_requests SET resolved=true,validation_run_id=$2 WHERE source_run_id=$1`, run, validation); err != nil {
		return err
	}
	return tx.Commit()
}
