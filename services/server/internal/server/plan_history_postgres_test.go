//go:build integration

package server

import (
	"testing"
)

func TestM10ClosedPlanReadOnly(t *testing.T) {
	p, ctx, item, editing, stage := m10PlanFixture(t)
	plan, err := p.SavePlan(ctx, item.ID, editing.ID, editing.Draft.Revision, 0, []PlanStageInput{stage})
	if err != nil {
		t.Fatal(err)
	}
	plan, err = p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if plan.ValidationRunID == nil {
		t.Fatal("missing validation")
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='failed',slot_released=true WHERE id=$1`, *plan.ValidationRunID); err != nil {
		t.Fatal(err)
	}
	active, err := p.Plan(ctx, item.ID, editing.ID)
	if err != nil || active.Status != "stopped" || active.Revision <= plan.Revision {
		t.Fatal("active reconciliation changed")
	}
	// Synthetic closed publication state; no model or application database involved.
	if _, err = p.DB.ExecContext(ctx, `UPDATE plans SET status='done',revision=revision+1 WHERE id=$1`, plan.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE editing_sessions SET status='published',closed_at=now() WHERE id=$1`, editing.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `DELETE FROM drafts WHERE test_id=$1`, item.ID); err != nil {
		t.Fatal(err)
	}
	other, err := p.CreatePlatformTest(ctx, item.WorkspaceID, "other", "", "usecase", nil)
	if err != nil {
		t.Fatal(err)
	}
	otherSession, _, err := p.StartEditingSession(ctx, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := p.CreateWorkspace(ctx, "foreign")
	if err != nil {
		t.Fatal(err)
	}
	foreignTest, err := p.CreatePlatformTest(ctx, foreign.ID, "foreign", "", "usecase", nil)
	if err != nil {
		t.Fatal(err)
	}
	foreignSession, _, err := p.StartEditingSession(ctx, foreignTest.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Pin the pool to one connection, then enforce PostgreSQL read-only mode.
	// Any hidden refresh/write or locking of a Draft would fail this request.
	p.DB.SetMaxOpenConns(1)
	if _, err = p.DB.ExecContext(ctx, `SET default_transaction_read_only=on`); err != nil {
		t.Fatal(err)
	}
	defer p.DB.ExecContext(ctx, `SET default_transaction_read_only=off`)
	closed, err := p.Plan(ctx, item.ID, editing.ID)
	if err != nil || closed.Status != "done" || closed.ID != plan.ID || closed.Revision != active.Revision+1 {
		t.Fatal("closed done unavailable or mutated")
	}
	for _, pair := range [][2]string{{item.ID, otherSession.ID}, {other.ID, editing.ID}, {item.ID, foreignSession.ID}, {foreignTest.ID, editing.ID}} {
		if _, err = p.Plan(ctx, pair[0], pair[1]); err == nil {
			t.Fatal("foreign session ownership accepted")
		}
	}
	if _, err = p.DB.ExecContext(ctx, `SET default_transaction_read_only=off`); err != nil {
		t.Fatal(err)
	}
	if _, err = p.SavePlan(ctx, item.ID, editing.ID, editing.Draft.Revision, closed.Revision, []PlanStageInput{stage}); err == nil {
		t.Fatal("closed write gate relaxed")
	}
}
