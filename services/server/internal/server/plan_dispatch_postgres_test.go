//go:build integration

package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestM10PostgresPlanModuleDispatchIsolation(t *testing.T) {
	for _, mode := range []string{"create", "modify", "active_session", "create_stale", "create_atomic_rollback"} {
		t.Run(mode, func(t *testing.T) { runM10PlanModuleFlow(t, mode, nil) })
	}
}
func runM10PlanModuleFlow(t *testing.T, mode string, bridge func(*testing.T, *Postgres, *Assignment, *LocalArtifacts)) {

	p, ctx, item, editing, stage := m10PlanFixture(t)
	config, err := normalizeConfig(WorkspaceConfig{Name: "scope", Purpose: "test", BackgroundSummary: "synthetic", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://example.test", Purpose: "test"}}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, item.WorkspaceID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DiscardEditingSession(ctx, item.ID, editing.ID, editing.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	editing, _, err = p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(mode, "create") {
		stage.Action = "create"
		stage.ModuleVersionID = ""
		stage.Module = &PlannedModule{Slug: "new-module", ModuleKind: "step", Description: "synthetic"}
	} else {
		stage.Action = "modify"
	}
	plan, err := p.SavePlan(ctx, item.ID, editing.ID, editing.Draft.Revision, 0, []PlanStageInput{stage})
	if err != nil {
		t.Fatal(err)
	}
	if mode == "active_session" {
		if _, _, err = p.StartEditingSession(ctx, plan.Stages[0].ModuleTestID); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	plan, _, _, err = lockPlan(ctx, tx, plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	plan.Status = "running"
	if _, err = tx.ExecContext(ctx, `UPDATE plans SET status='running' WHERE id=$1`, plan.ID); err != nil {
		t.Fatal(err)
	}
	run, err := p.dispatchPlanModule(ctx, tx, plan, item.WorkspaceID, 0)
	if mode == "active_session" {
		if err == nil {
			t.Fatal("active Module session taken over")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	var script string
	if err = tx.QueryRowContext(ctx, `SELECT author_payload,script_snapshot FROM runs WHERE id=$1`, run).Scan(&raw, &script); err != nil {
		t.Fatal(err)
	}
	var input AuthorInput
	if json.Unmarshal(raw, &input) != nil || input.Platform == nil || stringValue(input.Platform.PlanID) != plan.ID || stringValue(input.Platform.StageID) != stage.ID {
		t.Fatal("stage binding missing")
	}
	if mode == "modify" && (input.SourceVersion == nil || input.SourceVersion.ID != stage.ModuleVersionID || script != m10BundleModule) {
		t.Fatal("modify did not pin requested source")
	}
	if strings.HasPrefix(mode, "create") && (input.SourceVersion != nil || input.Platform.Module.Slug != "new-module") {
		t.Fatal("create identity wrong")
	}
	if _, err = p.dispatchPlanModule(ctx, tx, plan, item.WorkspaceID, 0); err == nil {
		t.Fatal("duplicate Stage dispatch")
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "m10-stage", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m10-stage", 1)
	if err != nil || a == nil || a.ID != run {
		t.Fatal("claim stage", err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	meta := *input.Platform.Module
	meta.ExportName = "prepare"
	meta.Harness = strings.ReplaceAll(m10BundleSpec, "@lib/setup", "@lib/"+meta.Slug)
	artifact, err := files.Save(a.ID, a.AttemptID, "author.json", strings.NewReader(jsonText(map[string]any{"message": "candidate", "script": m10BundleModule, "module": meta, "requestValidation": true})))
	if err != nil {
		t.Fatal(err)
	}
	if err = p.SaveArtifact(ctx, artifact); err != nil {
		t.Fatal(err)
	}
	if err = p.Complete(ctx, "m10-stage", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	finished, err := p.Run(ctx, a.ID)
	if err != nil || finished.Status != "succeeded" {
		t.Fatal("stage completion", finished.Status, err)
	}
	var candidate, hash string
	var revision int
	if err = p.DB.QueryRowContext(ctx, `SELECT id,bundle_hash,revision FROM plan_module_candidates WHERE source_run_id=$1`, a.ID).Scan(&candidate, &hash, &revision); err != nil || !ValidID(candidate) || !sha256Hex(hash) || revision != a.Author.BaseRevision+1 {
		t.Fatal("candidate not bound before validation", err)
	}
	var count int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM test_versions WHERE id=$1`, candidate).Scan(&count); err != nil || count != 0 {
		t.Fatal("candidate prematurely published", err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE plan_module_candidates SET revision=revision+1 WHERE id=$1`, candidate); err == nil {
		t.Fatal("candidate binding mutable")
	}
	if err = p.ReleaseSlots(ctx, "m10-stage", nil); err != nil {
		t.Fatal(err)
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM module_validation_requests WHERE source_run_id=$1 AND validation_run_id IS NOT NULL`, a.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("candidate not validated after reclaim", err)
	}
	validation, err := p.Claim(ctx, "m10-stage", 1)
	if err != nil || validation == nil || validation.Kind != "validation" {
		t.Fatal("claim validation", err)
	}
	// Synthetic report tests Server state transitions; runtime acceptance is separate.
	for name, body := range map[string]string{"report.html": "<html>synthetic stage proof</html>", "results.json": `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`} {
		artifact, err = files.Save(validation.ID, validation.AttemptID, name, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatal(err)
		}
	}
	if err = p.Complete(ctx, "m10-stage", validation.ID, validation.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "m10-stage", nil); err != nil {
		t.Fatal(err)
	}
	composed, err := p.Plan(ctx, item.ID, editing.ID)
	if err != nil || composed.Status != "composed" || composed.Stages[0].CandidateVersionID == nil || *composed.Stages[0].CandidateVersionID != candidate {
		t.Fatal("candidate Compose failed", err)
	}
	usecase, err := p.Claim(ctx, "m10-stage", 1)
	if err != nil || usecase == nil || usecase.TestID == nil || *usecase.TestID != item.ID || len(usecase.Files) != 2 {
		t.Fatal("pinned Use Case bundle missing", err)
	}
	for name, body := range map[string]string{"report.html": "<html>synthetic Use Case proof</html>", "results.json": `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`} {
		artifact, err = files.Save(usecase.ID, usecase.AttemptID, name, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatal(err)
		}
	}
	if err = p.Complete(ctx, "m10-stage", usecase.ID, usecase.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if _, err = p.CreatePlanSummary(ctx, composed.ID, composed.Revision, usecase.ID); err == nil {
		t.Fatal("summary allowed before validation reclaim")
	}
	if err = p.ReleaseSlots(ctx, "m10-stage", nil); err != nil {
		t.Fatal(err)
	}
	summary, err := p.CreatePlanSummary(ctx, composed.ID, composed.Revision, usecase.ID)
	if err != nil {
		t.Fatal("create batch summary", err)
	}
	repeat, err := p.CreatePlanSummary(ctx, composed.ID, composed.Revision, usecase.ID)
	if err != nil || repeat.ID != summary.ID {
		t.Fatal("duplicate batch summary", err)
	}
	summaryAssignment, err := p.Claim(ctx, "m10-stage", 1)
	if err != nil || summaryAssignment == nil || summaryAssignment.Author.Batch == nil || len(summaryAssignment.Author.Batch.Modules) != 1 || summaryAssignment.Author.Batch.Modules[0].VersionID != candidate {
		t.Fatal("batch snapshot missing", err)
	}
	if bridge != nil {
		bridge(t, p, summaryAssignment, files)
	} else {
		summaryBody := jsonText(summaryOutput{Message: "batch", Description: "synthetic flow and candidate", BackgroundSummary: "synthetic verification only"})
		artifact, err = files.Save(summaryAssignment.ID, summaryAssignment.AttemptID, "author.json", strings.NewReader(summaryBody))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatal(err)
		}
	}
	if err = p.Complete(ctx, "m10-stage", summaryAssignment.ID, summaryAssignment.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	view, err := p.PlanSummary(ctx, composed.ID)
	if err != nil || view.Status != "succeeded" || view.Stale || view.PublishReady || len(view.Candidates) != 1 {
		t.Fatal("batch view before reclaim", view, err)
	}
	if err = p.ReleaseSlots(ctx, "m10-stage", nil); err != nil {
		t.Fatal(err)
	}
	view, err = p.PlanSummary(ctx, composed.ID)
	if err != nil || !view.PublishReady {
		t.Fatal("batch view unavailable", err)
	}
	if mode == "create_stale" {
		target := summaryAssignment.Author.Batch.Modules[0]
		if _, err = p.SaveDraft(ctx, target.TestID, *target.EditingSessionID, target.Revision, m10BundleModule+"\n// revised"); err != nil {
			t.Fatal(err)
		}
		if _, err = p.PublishPlan(ctx, composed.ID, composed.Revision, summary.ID); err == nil {
			t.Fatal("stale candidate published")
		}
		if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM test_versions WHERE id=$1 OR test_id=$2`, candidate, item.ID).Scan(&count); err != nil || count != 0 {
			t.Fatal("partial batch published", err)
		}
		stale, err := p.PlanSummary(ctx, composed.ID)
		if err != nil || !stale.Stale || stale.PublishReady {
			t.Fatal("stale batch UI gate", err)
		}
		return
	}
	if mode == "create_atomic_rollback" {
		if _, err = p.DB.ExecContext(ctx, `CREATE FUNCTION reject_usecase_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.test_id='`+item.ID+`'::uuid THEN RAISE EXCEPTION 'synthetic atomic failure'; END IF;RETURN NEW;END;$$; CREATE TRIGGER reject_usecase_fixture BEFORE INSERT ON test_versions FOR EACH ROW EXECUTE FUNCTION reject_usecase_fixture()`); err != nil {
			t.Fatal(err)
		}
		if _, err = p.PublishPlan(ctx, composed.ID, composed.Revision, summary.ID); err == nil {
			t.Fatal("synthetic failure ignored")
		}
		if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM test_versions WHERE id=$1 OR test_id=$2`, candidate, item.ID).Scan(&count); err != nil || count != 0 {
			t.Fatal("candidate insert did not roll back", err)
		}
		return
	}
	published, err := p.PublishPlan(ctx, composed.ID, composed.Revision, summary.ID)
	if err != nil || len(published.ModuleVersions) != 1 || published.ModuleVersions[0].ID != candidate {
		t.Fatal("atomic publish", err)
	}
	retry, err := p.PublishPlan(ctx, composed.ID, composed.Revision, summary.ID)
	if err != nil || retry.UseCaseVersion.ID != published.UseCaseVersion.ID {
		t.Fatal("publish retry duplicated", err)
	}
	if _, err = p.PublishPlan(ctx, composed.ID, composed.Revision, NewID()); err == nil {
		t.Fatal("different publish body accepted")
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM version_dependencies WHERE version_id=$1 AND module_version_id=$2`, published.UseCaseVersion.ID, candidate).Scan(&count); err != nil || count != 1 {
		t.Fatal("atomic fixed dependency absent", err)
	}
	execution, err := p.CreateRun(ctx, item.ID)
	if err != nil {
		t.Fatal("published bundle execution", err)
	}
	assignment, err := p.Claim(ctx, "m10-stage", 1)
	if err != nil || assignment == nil || assignment.ID != execution.ID || len(assignment.Files) != 2 || assignment.ScriptOrigin != "ai" {
		t.Fatal("published bundle snapshot missing", err)
	}

}

func TestM10PostgresPlanConfirmDispatchCancel(t *testing.T) {
	p, ctx, item, editing, _ := m10PlanFixture(t)
	config, err := normalizeConfig(WorkspaceConfig{Name: "scope", Purpose: "test", BackgroundSummary: "synthetic", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://example.test", Purpose: "test"}}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, item.WorkspaceID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	plan, err := p.SavePlan(ctx, item.ID, editing.ID, editing.Draft.Revision, 0, []PlanStageInput{{ID: "build", Title: "Build", Action: "create", Module: &PlannedModule{Slug: "created", ModuleKind: "step", Description: "synthetic"}, Args: map[string]StageArgument{}}})
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil || confirmed.Status != "running" || confirmed.Stages[0].AuthorRunID == nil {
		t.Fatal("confirm did not dispatch", err)
	}
	repeated, err := p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil || stringValue(repeated.Stages[0].AuthorRunID) != *confirmed.Stages[0].AuthorRunID {
		t.Fatal("confirm retry redispatched", err)
	}
	if err = p.RegisterManager(ctx, "m10-cancel-stage", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m10-cancel-stage", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	stopped, err := p.CancelPlan(ctx, plan.ID, confirmed.Revision)
	if err != nil || stopped.Status != "stopped" {
		t.Fatal("cancel plan", err)
	}
	if err = p.Complete(ctx, "m10-cancel-stage", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	run, err := p.Run(ctx, a.ID)
	if err != nil || run.Status != "cancelled" {
		t.Fatal("late Module result accepted", err)
	}
	if err = p.ReleaseSlots(ctx, "m10-cancel-stage", nil); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM plan_module_candidates WHERE plan_id=$1`, plan.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("cancelled Plan advanced", err)
	}
}
