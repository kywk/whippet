//go:build integration

package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func splitFixture(t *testing.T, candidatePrefix ...bool) (*Postgres, context.Context, Test, EditingSession, *Plan, StageSplitRequest) {
	t.Helper()
	m10SkillRoot(t)
	cleanRuntimeEnv(t)
	p, ctx, item, s, prefix := m10PlanFixture(t)
	config, configErr := normalizeConfig(WorkspaceConfig{Name: "split", Purpose: "synthetic split", BackgroundSummary: "synthetic context", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://example.test", Purpose: "synthetic"}}}, true)
	if configErr != nil {
		t.Fatal(configErr)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, item.WorkspaceID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DiscardEditingSession(ctx, item.ID, s.ID, s.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	s, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	published := prefix
	if len(candidatePrefix) > 0 && candidatePrefix[0] {
		prefix.Action = "create"
		prefix.ModuleVersionID = ""
		prefix.ModuleTestID = ""
		prefix.Module = &PlannedModule{Slug: "verified-prefix", ModuleKind: "step", Description: "Independent verified prefix"}
	}
	source := PlanStageInput{ID: "work", Title: "Complete the order and preserve every assertion", Action: "create", Module: &PlannedModule{Slug: "whole-order", ModuleKind: "step", Description: "Keep confirmed goal, constraints, and order evidence"}, Args: map[string]StageArgument{"seed": {Kind: "binding", StageID: prefix.ID, Path: []string{}}}, Bind: "order"}
	tail := published
	tail.ID = "tail"
	tail.Args = map[string]StageArgument{"result": {Kind: "binding", StageID: source.ID, Path: []string{}}}
	plan, err := p.SavePlan(ctx, item.ID, s.ID, s.Draft.Revision, 0, []PlanStageInput{prefix, source, tail})
	if err != nil {
		t.Fatal(err)
	}
	plan, err = p.ConfirmPlanThrough(ctx, plan.ID, plan.Revision, prefix.ID)
	if err != nil {
		t.Fatal("pause prefix", err)
	}
	if prefix.Action == "create" {
		if err = p.RegisterManager(ctx, "split-manager", 1); err != nil {
			t.Fatal(err)
		}
		finishSplitStage(t, p, ctx, stringValue(plan.Stages[0].AuthorRunID), false)
		plan, err = p.Plan(ctx, item.ID, s.ID)
	}
	if err != nil || plan.Status != "confirmed" {
		t.Fatal("prefix not paused", err)
	}
	a := source
	a.ID = "work-a"
	a.Bind = ""
	a.Module = &PlannedModule{Slug: "order-a", ModuleKind: "step", Description: "Prepare order independently"}
	b := source
	b.Module = &PlannedModule{Slug: "order-b", ModuleKind: "step", Description: "Verify order and preserve all assertions"}
	b.Args = map[string]StageArgument{"input": {Kind: "binding", StageID: a.ID, Path: []string{}}}
	return p, ctx, item, s, plan, StageSplitRequest{plan.Revision, true, []PlanStageInput{a, b}}
}

func finishSplitStage(t *testing.T, p *Postgres, ctx context.Context, run string, fail bool) *Assignment {
	t.Helper()
	a, err := p.Claim(ctx, "split-manager", 1)
	if err != nil || a == nil || a.ID != run {
		t.Fatal("claim", err)
	}
	files, ok := p.Artifacts.(*LocalArtifacts)
	if !ok {
		files, err = NewLocalArtifacts(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		p.Artifacts = files
	}
	meta := *a.Author.Platform.Module
	meta.ExportName = "prepare"
	meta.Harness = strings.ReplaceAll(m10BundleSpec, "@lib/setup", "@lib/"+meta.Slug)
	artifact, err := files.Save(a.ID, a.AttemptID, "author.json", strings.NewReader(jsonText(map[string]any{"message": "candidate", "script": m10BundleModule, "module": meta, "requestValidation": true})))
	if err != nil {
		t.Fatal(err)
	}
	if err = p.SaveArtifact(ctx, artifact); err != nil {
		t.Fatal(err)
	}
	if err = p.Complete(ctx, "split-manager", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "split-manager", nil); err != nil {
		t.Fatal(err)
	}
	v, err := p.Claim(ctx, "split-manager", 1)
	if err != nil || v == nil || v.Kind != "validation" {
		t.Fatal("validation", err)
	}
	stats := `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`
	status := "succeeded"
	if fail {
		status = "failed"
		stats = `{"stats":{"expected":0,"unexpected":1,"flaky":0,"skipped":0,"duration":1},"errors":[]}`
	}
	for name, body := range map[string]string{"report.html": "<html>synthetic stage proof</html>", "results.json": stats} {
		artifact, err = files.Save(v.ID, v.AttemptID, name, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatal(err)
		}
	}
	if err = p.Complete(ctx, "split-manager", v.ID, v.AttemptID, Result{Status: status}); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "split-manager", nil); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestStageSplitPostgresPreservesPrefixAndResumes(t *testing.T) {
	p, ctx, item, s, original, request := splitFixture(t, true)
	prefix := jsonText(original.Stages[0])
	var wg sync.WaitGroup
	results := make([]*Plan, 2)
	errs := make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = p.SplitPlanStage(ctx, original.ID, "work", request)
		}(i)
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil || jsonText(results[0]) != jsonText(results[1]) {
		t.Fatal("concurrent split", errs)
	}
	plan := results[0]
	if plan.Revision != original.Revision+1 || plan.Status != "confirmed" || len(plan.Stages) != 4 || jsonText(plan.Stages[0]) != prefix || plan.Stages[3].Args["result"].StageID != "work" {
		t.Fatal("prefix/downstream changed")
	}
	var count int
	if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs`).Scan(&count); err != nil || count != 2 {
		t.Fatal("split started a Run", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE plan_stage_splits SET request=request WHERE plan_id=$1`, plan.ID); err == nil {
		t.Fatal("mutable split policy")
	}
	if _, err := p.SavePlan(ctx, item.ID, s.ID, s.Draft.Revision, plan.Revision, request.Stages); !errors.Is(err, ErrConflict) {
		t.Fatal("whole rewrite minted budget", err)
	}
	if _, err := p.SplitPlanStage(ctx, plan.ID, "work", StageSplitRequest{plan.Revision, true, request.Stages}); !errors.Is(err, ErrConflict) {
		t.Fatal("recursive split", err)
	}
	if err := p.RegisterManager(ctx, "split-manager", 1); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WHIPPET_AI_BASE_URL", "https://changed.example/v1")
	for _, stageID := range []string{"work-a", "work"} {
		next, err := p.ConfirmPlanThrough(ctx, plan.ID, plan.Revision, stageID)
		if err != nil {
			t.Fatal("confirm child", err)
		}
		var run string
		for _, stage := range next.Stages {
			if stage.ID == stageID {
				run = stringValue(stage.AuthorRunID)
			}
		}
		a := finishSplitStage(t, p, ctx, run, false)
		if a.Author.Budget.MaxModelRequests != 4 || a.Author.Budget.MaxToolCalls != 6 || a.Author.Budget.MaxDurationMS != 90000 || a.Author.Budget.effectiveMaxOutputTokens() != 16384 || a.Author.Runtime.BaseURL != "https://opencode.ai/inference/go/openai/v1" {
			t.Fatal("inflated/drifted child allocation")
		}
		if !strings.Contains(jsonText(a.Author.Messages), "preserve every assertion") || !strings.Contains(jsonText(a.Author.Messages), "order evidence") {
			t.Fatal("original goal lost")
		}
		if !strings.Contains(jsonText(a.Author.Messages), stringValue(plan.Stages[0].CandidateVersionID)) {
			t.Fatal("original parent binding lost its pinned upstream contract")
		}
		plan, err = p.Plan(ctx, item.ID, s.ID)
		if err != nil || plan.Status != "confirmed" || jsonText(plan.Stages[0]) != prefix {
			t.Fatal("child did not pause with prefix", err)
		}
	}
	if plan.Stages[1].Status != "ready" || plan.Stages[2].Status != "ready" || plan.Stages[3].Status != "pending" {
		t.Fatal("unconfirmed tail advanced")
	}
	if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM plan_stage_split_runs WHERE plan_id=$1`, plan.ID).Scan(&count); err != nil || count != 2 {
		t.Fatal("reservation count", err)
	}
	if _, err := p.DB.ExecContext(ctx, `DELETE FROM plan_stage_split_runs WHERE plan_id=$1`, plan.ID); err == nil {
		t.Fatal("refill reservation")
	}
	composed, err := p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil || composed.Status != "composed" || composed.ValidationRunID == nil {
		t.Fatal("compose", err)
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM test_versions WHERE test_id=$1`, item.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("published without human", err)
	}
	if replay, err := p.SplitPlanStage(ctx, original.ID, "work", request); err != nil || replay.Revision != results[0].Revision {
		t.Fatal("historical receipt changed", err)
	}
}

func TestStageSplitPostgresFailureAndStrictInput(t *testing.T) {
	p, ctx, item, s, plan, request := splitFixture(t)
	admin := NewID()
	api := NewAPI(p, nil, nil, NewID(), slog.New(slog.NewTextHandler(io.Discard, nil))).WithAdminAccess(admin, "").Handler(nil)
	for _, raw := range []string{strings.Replace(jsonText(request), `"confirmed":true`, `"confirmed":false`, 1), strings.Replace(jsonText(request), `"confirmed":true`, `"confirmed":true,"confirmed":true`, 1), strings.Replace(jsonText(request), `"confirmed":true`, `"confirmed":true,"runtime":{}`, 1)} {
		r := httptest.NewRequest("POST", "/api/plans/"+plan.ID+"/stages/work/split", strings.NewReader(raw))
		r.Header.Set("X-Whippet-Admin-Token", admin)
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("invalid split status %d", w.Code)
		}
	}
	bad := request
	bad.PlanRevision++
	if _, err := p.SplitPlanStage(ctx, plan.ID, "work", bad); !errors.Is(err, ErrConflict) {
		t.Fatal("stale CAS", err)
	}
	bad = request
	bad.Stages = append([]PlanStageInput{}, request.Stages...)
	bad.Stages[1].ID = "wrong"
	if _, err := p.SplitPlanStage(ctx, plan.ID, "work", bad); !errors.Is(err, ErrInvalid) {
		t.Fatal("downstream ID changed", err)
	}
	plan, err := p.SplitPlanStage(ctx, plan.ID, "work", request)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "split-manager", 1); err != nil {
		t.Fatal(err)
	}
	plan, err = p.ConfirmPlanThrough(ctx, plan.ID, plan.Revision, "work-a")
	if err != nil {
		t.Fatal(err)
	}
	finishSplitStage(t, p, ctx, stringValue(plan.Stages[1].AuthorRunID), true)
	plan, err = p.Plan(ctx, item.ID, s.ID)
	if err != nil || plan.Status != "stopped" || plan.Stages[2].AuthorRunID != nil || plan.Stages[1].Status != "failed" {
		t.Fatal("failed validation advanced", err)
	}
	retry, err := p.StageRetry(ctx, plan.ID, "work-a")
	if err != nil || retry.Eligible || stringValue(retry.Reason) != "split_budget_reserved" {
		t.Fatal("retry refilled allocation", err)
	}
	if _, err = p.ConfirmPlan(ctx, plan.ID, plan.Revision); !errors.Is(err, ErrConflict) {
		t.Fatal("continued failed split", err)
	}
}
