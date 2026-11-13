package server

import (
	"context"
	"database/sql"
	"errors"
)

func (p *Postgres) advancePlanInTx(ctx context.Context, tx *sql.Tx, plan *Plan, d draftState, session EditingSession) error {
	stop := func(message string) error {
		plan.Status = "stopped"
		plan.Error = &message
		plan.Revision++
		_, err := tx.ExecContext(ctx, `UPDATE plans SET status='stopped',error=$2,revision=$3,stages=$4 WHERE id=$1`, plan.ID, message, plan.Revision, jsonText(plan.Stages))
		return err
	}
	if plan.Status != "running" {
		return nil
	}
	if d.Revision != plan.BaseRevision || session.ContextRevision != plan.ContextRevision {
		return stop("Use Case context changed")
	}
	for i := range plan.Stages {
		stage := &plan.Stages[i]
		if stage.Status == "ready" {
			continue
		}
		if stage.Action == "reuse" {
			stage.Status = "ready"
			continue
		}
		if stage.Status == "pending" {
			if _, err := tx.ExecContext(ctx, "SAVEPOINT stage_dispatch"); err != nil {
				return err
			}
			_, err := p.dispatchPlanModule(ctx, tx, plan, session.WorkspaceID, i)
			if err != nil {
				if _, e := tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT stage_dispatch"); e != nil {
					return e
				}
				stage.Status = "failed"
				return stop("Module dispatch unavailable; check active editing session, slug and confirmed scope")
			}
			return nil
		}
		if stage.Status == "authoring" {
			if stage.AuthorRunID == nil {
				return stop("Module author binding missing")
			}
			var status string
			var released bool
			if err := tx.QueryRowContext(ctx, `SELECT status,slot_released FROM runs WHERE id=$1`, *stage.AuthorRunID).Scan(&status, &released); err != nil {
				return err
			}
			if !Terminal(status) {
				return nil
			}
			if status != "succeeded" {
				stage.Status = "failed"
				return stop("Module author did not succeed")
			}
			if !released {
				return nil
			}
			var candidate string
			var revision int
			var validation *string
			var resolved bool
			if err := tx.QueryRowContext(ctx, `SELECT c.id,c.revision,q.validation_run_id,q.resolved FROM plan_module_candidates c JOIN module_validation_requests q ON q.source_run_id=c.source_run_id WHERE c.source_run_id=$1 AND c.plan_id=$2 AND c.stage_id=$3`, *stage.AuthorRunID, plan.ID, stage.ID).Scan(&candidate, &revision, &validation, &resolved); err != nil {
				return stop("Module candidate unavailable")
			}
			if !resolved {
				return nil
			}
			if validation == nil {
				stage.Status = "failed"
				return stop("Module validation scope or revision changed")
			}
			stage.CandidateVersionID = &candidate
			stage.DraftRevision = &revision
			stage.ValidationRunID = validation
			stage.Status = "validating"
			if _, err := tx.ExecContext(ctx, `UPDATE plans SET stages=$2 WHERE id=$1`, plan.ID, jsonText(plan.Stages)); err != nil {
				return err
			}
		}
		if stage.Status == "validating" {
			if stage.ValidationRunID == nil || stage.CandidateVersionID == nil {
				return stop("Module validation binding missing")
			}
			var status, editing string
			var released bool
			if err := tx.QueryRowContext(ctx, `SELECT status,slot_released,editing_session_id FROM runs WHERE id=$1`, *stage.ValidationRunID).Scan(&status, &released, &editing); err != nil {
				return err
			}
			if !Terminal(status) {
				return nil
			}
			if status != "succeeded" {
				stage.Status = "failed"
				return stop("Module validation did not succeed")
			}
			if !released {
				return nil
			}
			md, ms, err := requireEditingDraft(ctx, tx, stage.ModuleTestID, editing)
			if err != nil {
				return stop("Module editing session changed")
			}
			var revision int
			var contextRevision int64
			if err = tx.QueryRowContext(ctx, `SELECT revision,context_revision FROM plan_module_candidates WHERE id=$1`, *stage.CandidateVersionID).Scan(&revision, &contextRevision); err != nil {
				return err
			}
			if md.Revision != revision || ms.ContextRevision != contextRevision || md.ValidationRunID == nil || *md.ValidationRunID != *stage.ValidationRunID {
				return stop("Module candidate changed")
			}
			proof, err := p.validationProof(ctx, tx, md)
			if err != nil || checkPublication(revision, true, md, proof) != nil {
				return stop("Module validation evidence unavailable")
			}
			stage.Status = "ready"
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE plans SET stages=$2 WHERE id=$1`, plan.ID, jsonText(plan.Stages)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "SAVEPOINT compose_candidate"); err != nil {
		return err
	}
	composed, err := composePlan(ctx, tx, plan, d, session)
	if err != nil {
		if _, e := tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT compose_candidate"); e != nil {
			return e
		}
		return stop("Compose scope, candidate or validation binding unavailable")
	}
	*plan = *composed
	return nil
}
func (p *Postgres) progressRunningPlans(ctx context.Context) error {
	rows, err := p.DB.QueryContext(ctx, `SELECT id FROM plans WHERE status='running' ORDER BY id`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		tx, e := p.DB.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		plan, d, s, e := lockPlan(ctx, tx, id)
		if e == nil && plan.Status == "running" {
			e = p.advancePlanInTx(ctx, tx, plan, d, s)
		}
		if errors.Is(e, ErrConflict) || errors.Is(e, ErrNotFound) {
			if _, e = tx.ExecContext(ctx, `UPDATE plans SET status='stopped',revision=revision+1,error='Owning editing session changed' WHERE id=$1 AND status='running'`, id); e == nil {
				_, e = tx.ExecContext(ctx, `UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END WHERE (author_payload->'platform'->>'planId'=$1 OR id IN (SELECT q.validation_run_id FROM module_validation_requests q JOIN runs source ON source.id=q.source_run_id WHERE source.author_payload->'platform'->>'planId'=$1)) AND status IN ('queued','dispatched','running','collecting')`, id)
			}
		}
		if e != nil {
			tx.Rollback()
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
	}
	return nil
}
