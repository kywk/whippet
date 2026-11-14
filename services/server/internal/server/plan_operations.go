package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

func lockPlan(ctx context.Context, tx *sql.Tx, id string) (*Plan, draftState, EditingSession, error) {
	var test, session string
	if err := tx.QueryRowContext(ctx, `SELECT test_id,editing_session_id FROM plans WHERE id=$1`, id).Scan(&test, &session); err != nil {
		return nil, draftState{}, EditingSession{}, dbError(err)
	}
	d, s, err := requireEditingDraft(ctx, tx, test, session)
	if err != nil {
		return nil, d, s, err
	}
	if err = refreshPlanOutcomes(ctx, tx, test); err != nil {
		return nil, d, s, err
	}
	plan, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1 FOR UPDATE`, id))
	return plan, d, s, err
}
func priorPlanOperation(ctx context.Context, tx *sql.Tx, id, operation string, revision int) (*Plan, error) {
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT result FROM plan_operations WHERE plan_id=$1 AND operation=$2 AND request_revision=$3`, id, operation, revision).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var result Plan
	if err = json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
func savePlanOperation(ctx context.Context, tx *sql.Tx, plan *Plan, operation string, revision int) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO plan_operations(plan_id,operation,request_revision,result) VALUES($1,$2,$3,$4)`, plan.ID, operation, revision, jsonText(plan))
	return err
}
func (p *Postgres) ConfirmPlan(ctx context.Context, id string, revision int) (*Plan, error) {
	if revision < 1 {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	plan, d, s, err := lockPlan(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	prior, err := priorPlanOperation(ctx, tx, id, "confirm", revision)
	if err != nil {
		return nil, err
	}
	if prior != nil {
		return prior, tx.Commit()
	}
	if plan.Revision != revision || plan.Status != "draft" || plan.BaseRevision != d.Revision || plan.ContextRevision != s.ContextRevision {
		return nil, ErrConflict
	}
	hasWork := false
	for _, stage := range plan.Stages {
		if stage.Action != "reuse" {
			hasWork = true
		}
	}
	if hasWork {
		plan.Status = "running"
		plan.Revision++
		if _, err = tx.ExecContext(ctx, `UPDATE plans SET status='running',revision=$2 WHERE id=$1`, plan.ID, plan.Revision); err != nil {
			return nil, err
		}
		if err = p.advancePlanInTx(ctx, tx, plan, d, s); err != nil {
			return nil, err
		}
	} else {
		plan, err = composePlan(ctx, tx, plan, d, s)
		if err != nil {
			return nil, err
		}
	}
	if err = savePlanOperation(ctx, tx, plan, "confirm", revision); err != nil {
		return nil, err
	}
	return plan, tx.Commit()
}
func (p *Postgres) CancelPlan(ctx context.Context, id string, revision int) (*Plan, error) {
	if revision < 1 {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	plan, _, _, err := lockPlan(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	prior, err := priorPlanOperation(ctx, tx, id, "cancel", revision)
	if err != nil {
		return nil, err
	}
	if prior != nil {
		return prior, tx.Commit()
	}
	if plan.Revision != revision || plan.Status == "done" || plan.Status == "stopped" {
		return nil, ErrConflict
	}
	runs := []string{}
	if plan.ValidationRunID != nil {
		runs = append(runs, *plan.ValidationRunID)
	}
	for _, s := range plan.Stages {
		if s.AuthorRunID != nil {
			runs = append(runs, *s.AuthorRunID)
			var pending *string
			err := tx.QueryRowContext(ctx, `SELECT validation_run_id FROM module_validation_requests WHERE source_run_id=$1`, *s.AuthorRunID).Scan(&pending)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if pending != nil {
				runs = append(runs, *pending)
			}
		}
		if s.ValidationRunID != nil {
			runs = append(runs, *s.ValidationRunID)
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT ps.run_id FROM plan_summaries ps JOIN runs r ON r.id=ps.run_id WHERE ps.plan_id=$1 AND r.status IN ('queued','dispatched','running','collecting')`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var run string
		if err = rows.Scan(&run); err != nil {
			rows.Close()
			return nil, err
		}
		runs = append(runs, run)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, run := range runs {
		if _, err = tx.ExecContext(ctx, `UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=$1 AND status IN ('queued','dispatched','running','collecting')`, run); err != nil {
			return nil, err
		}
	}
	plan, err = scanPlan(tx.QueryRowContext(ctx, `UPDATE plans SET status='stopped',revision=revision+1,error='cancelled' WHERE id=$1 RETURNING `+planColumns, id))
	if err != nil {
		return nil, err
	}
	if err = savePlanOperation(ctx, tx, plan, "cancel", revision); err != nil {
		return nil, err
	}
	return plan, tx.Commit()
}

// No run lock is taken: completion commits before invoking this seam. Cancel
// locks Plan then Run, so using a run->plan lock order here would deadlock.
func refreshPlanOutcomes(ctx context.Context, q interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, test string) error {
	_, err := q.ExecContext(ctx, `UPDATE plans p SET status='stopped',revision=p.revision+1,error='Use Case validation did not succeed'
 FROM runs r WHERE p.test_id=$1 AND p.validation_run_id=r.id AND p.status='composed' AND r.status IN ('failed','cancelled','timed_out','interrupted')`, test)
	return err
}

func composePlan(ctx context.Context, tx *sql.Tx, plan *Plan, d draftState, s EditingSession) (*Plan, error) {
	var origin string
	if err := tx.QueryRowContext(ctx, `SELECT script_origin FROM plans WHERE id=$1`, plan.ID).Scan(&origin); err != nil {
		return nil, err
	}
	script, stages, err := composeUseCase(ctx, tx, s.WorkspaceID, plan.Stages, plan.ID)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,stages) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, d.TestID, d.Revision+1, script, scriptHash(script), d.timeoutMS, settingsJSON(d.WorkspaceSettings), jsonText(d.WorkspaceContext), origin, stagesJSON(stages)); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE drafts SET current_revision=current_revision+1,validation_run_id=NULL,summary_run_id=NULL,summary_description=NULL,summary_background=NULL,summary_name=NULL,updated_at=now() WHERE test_id=$1`, d.TestID); err != nil {
		return nil, err
	}
	d, err = scanDraft(tx.QueryRowContext(ctx, draftSelect, d.TestID))
	if err != nil {
		return nil, err
	}
	bundle, err := bundleForDraft(ctx, tx, d)
	if err != nil {
		return nil, err
	}
	run, err := enqueueValidationSnapshot(ctx, tx, d, bundle)
	if err != nil {
		return nil, err
	}
	for i := range plan.Stages {
		plan.Stages[i].Status = "ready"
	}
	plan, err = scanPlan(tx.QueryRowContext(ctx, `UPDATE plans SET revision=revision+1,base_revision=$2,status='composed',stages=$3,validation_run_id=$4,error=NULL WHERE id=$1 RETURNING `+planColumns, plan.ID, d.Revision, jsonText(plan.Stages), run.ID))
	if err != nil {
		return nil, err
	}

	return plan, nil
}
