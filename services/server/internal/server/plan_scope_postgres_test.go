//go:build integration

package server

import (
	"errors"
	"testing"
)

func TestM10PlanPureComputeRequiresScope(t *testing.T) {
	p, ctx, item, editing, reuse := m10PlanFixture(t)
	create := PlanStageInput{ID: "double", Title: "Pure computation", Action: "create", Module: &PlannedModule{Slug: "pure-double", ModuleKind: "step", Description: "Pure computation only; no browser or network"}, Args: map[string]StageArgument{}}
	plan, err := p.SavePlan(ctx, item.ID, editing.ID, editing.Draft.Revision, 0, []PlanStageInput{reuse, create})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	locked, _, _, err := lockPlan(ctx, tx, plan.ID)
	if err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	locked.Status = "running"
	locked.Stages[0].Status = "ready"
	_, dispatchErr := p.dispatchPlanModule(ctx, tx, locked, item.WorkspaceID, 1)
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(dispatchErr, ErrScopeConfirmation) {
		t.Fatal("expected exact scope confirmation rejection")
	}
	stopped, err := p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if stopped.Status != "stopped" || stopped.Stages[0].Status != "ready" || stopped.Stages[1].Status != "failed" || stopped.Stages[1].ModuleTestID != "" || stopped.Stages[1].AuthorRunID != nil {
		t.Fatal("unexpected stopped state")
	}
	var count int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM tests WHERE workspace_id=$1 AND slug='pure-double'`, item.WorkspaceID).Scan(&count); err != nil || count != 0 {
		t.Fatal("candidate escaped rollback")
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE workspace_id=$1`, item.WorkspaceID).Scan(&count); err != nil || count != 0 {
		t.Fatal("run escaped rollback")
	}
	t.Log("exact dispatch error scope_confirmation_required; stopped Plan, ready reuse, failed create, no candidate or Run")
}
