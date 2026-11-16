//go:build integration

package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPlanStageAuthorReceivesPinnedContext(t *testing.T) {
	p, ctx, item, session, reuse := m10PlanFixture(t)
	config := WorkspaceConfig{Name: "context", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://example.test"}}}
	if _, err := p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, item.WorkspaceID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DiscardEditingSession(ctx, item.ID, session.ID, session.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := PlanStageInput{ID: "verify", Title: "verify", Action: "create", Module: &PlannedModule{Slug: "verify", ModuleKind: "step", Description: "Verify upstream output"}, Args: map[string]StageArgument{"seed": {Kind: "binding", StageID: reuse.ID, Path: []string{}}}}
	plan, err := p.SavePlan(ctx, item.ID, session.ID, session.Draft.Revision, 0, []PlanStageInput{reuse, create})
	if err != nil {
		t.Fatal(err)
	}
	latest := NewID()
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings,module,script_origin) SELECT $1,test_id,2,script,timeout_ms,workspace_settings,jsonb_set(module,'{returns}','"WRONG_LATEST"'::jsonb),script_origin FROM test_versions WHERE id=$2`, latest, reuse.ModuleVersionID); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$1 WHERE id=$2`, latest, plan.Stages[0].ModuleTestID); err != nil {
		t.Fatal(err)
	}
	plan, err = p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "context-manager", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "context-manager", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	check := func(a *Assignment) {
		t.Helper()
		body := ""
		for _, m := range a.Author.Messages {
			body += m.Content
		}
		for _, want := range []string{`"args"`, `"seed"`, reuse.ModuleVersionID, `"exportName":"prepare"`, `"returns"`, `DATA`} {
			if !strings.Contains(body, want) {
				t.Fatalf("author missing approved binding or pinned contract: %s", want)
			}
		}
		if strings.Contains(body, "WRONG_LATEST") {
			t.Fatal("latest pointer replaced Plan pin")
		}
		if strings.Contains(body, "export async function") || strings.Contains(body, "@playwright/test") {
			t.Fatal("upstream code/harness leaked into contract context")
		}
	}
	check(a)
	if err = p.Complete(ctx, "context-manager", a.ID, a.AttemptID, Result{Status: "failed", Error: "synthetic"}); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "context-manager", nil); err != nil {
		t.Fatal(err)
	}
	r, err := p.StageRetry(ctx, plan.ID, "verify")
	if err != nil || !r.Eligible {
		t.Fatal(err)
	}
	plan, err = p.RetryPlanStage(ctx, plan.ID, "verify", StageRetryRequest{r.PlanRevision, r.Source.ModuleRevision, r.Source.ModuleContextRevision, true, "repair without restating upstream contract"})
	if err != nil {
		t.Fatal(err)
	}
	a, err = p.Claim(ctx, "context-manager", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	check(a)
	// Assignment preserves the same immutable context as the stored Run snapshot.
	var raw []byte
	if err = p.DB.QueryRowContext(ctx, `SELECT author_payload FROM runs WHERE id=$1`, a.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var snapshot AuthorInput
	if json.Unmarshal(raw, &snapshot) != nil {
		t.Fatal("invalid snapshot")
	}
	check(&Assignment{Author: &snapshot})
}
