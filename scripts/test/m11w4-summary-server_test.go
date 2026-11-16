//go:build integration

// Synthetic evidence verifies server state transitions, not actual Playwright execution.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestM11W4ModuleExternalSummary(t *testing.T) {
	for _, stale := range []bool{false, true} {
		name := "current"
		if stale {
			name = "stale"
		}
		t.Run(name, func(t *testing.T) { m11w4ModuleFixture(t, stale) })
	}
}

func m11w4ModuleFixture(t *testing.T, stale bool) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "standalone module")
	if err != nil {
		t.Fatal(err)
	}
	slug := "standalone"
	item, err := p.CreatePlatformTest(ctx, w.ID, "Module", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	metadata := &Module{Slug: slug, ModuleKind: "step", ExportName: "prepare", Harness: "import {test,expect} from '@playwright/test'; import {prepare} from '@lib/standalone'; test('module',async()=>{expect(await prepare({})).toEqual({name:'alpha'});});"}
	body := "export async function prepare(_args:any){return {name:'alpha'};}"
	draft, err := p.SavePlatformDraft(ctx, item.ID, session.ID, session.Draft.Revision, body, metadata, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, NewID()); err == nil {
		t.Fatal("unvalidated module summarized")
	}
	validation, err := p.ValidateDraft(ctx, item.ID, session.ID, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "m10-module-summary", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m10-module-summary", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	for name, data := range map[string]string{"report.html": "<html>synthetic Module verification</html>", "results.json": `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`} {
		artifact, e := files.Save(a.ID, a.AttemptID, name, strings.NewReader(data))
		if e != nil {
			t.Fatal(e)
		}
		if e = p.SaveArtifact(ctx, artifact); e != nil {
			t.Fatal(e)
		}
	}
	if err = p.Complete(ctx, "m10-module-summary", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if _, err = p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, validation.ID); err == nil {
		t.Fatal("validation not reclaimed")
	}
	if err = p.ReleaseSlots(ctx, "m10-module-summary", nil); err != nil {
		t.Fatal(err)
	}
	m11w4SetExternal(t, p, ctx, w.ID)
	summary, err := p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, validation.ID)
	if err != nil {
		t.Fatal("create summary", err)
	}
	m11w4Summary(t, p, ctx, w.ID, item.ID, session.ID, "", summary.ID, validation.ID, "module", stale)
}

func TestM11W4BatchExternalSummary(t *testing.T) {
	for _, stale := range []bool{false, true} {
		name := "current"
		if stale {
			name = "stale"
		}
		t.Run(name, func(t *testing.T) { m11w4BatchFixture(t, stale) })
	}
}

func m11w4BatchFixture(t *testing.T, stale bool) {
	mode := "create"
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
	m11w4SetExternal(t, p, ctx, item.WorkspaceID)
	summary, err := p.CreatePlanSummary(ctx, composed.ID, composed.Revision, usecase.ID)
	if err != nil {
		t.Fatal("create batch summary", err)
	}
	m11w4Summary(t, p, ctx, item.WorkspaceID, item.ID, editing.ID, composed.ID, summary.ID, usecase.ID, "batch", stale)
}

func m11w4SetExternal(t *testing.T, p *Postgres, ctx context.Context, workspaceID string) {
	t.Helper()
	w, err := p.Workspace(ctx, workspaceID)
	if err != nil {
		t.Fatal("workspace", err)
	}
	if _, err = p.SetAuthorEngine(ctx, workspaceID, w.Revision, "external"); err != nil {
		t.Fatal("set engine", err)
	}
	// The tests operate only in an isolated synthetic schema.
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed' WHERE id=$1`, workspaceID); err != nil {
		t.Fatal("scope", err)
	}
}

func TestM11W4TestExternalSummary(t *testing.T) {
	for _, stale := range []bool{false, true} {
		name := "current"
		if stale {
			name = "stale"
		}
		t.Run(name, func(t *testing.T) { m11w4TestFixture(t, stale) })
	}
}

func m11w4TestFixture(t *testing.T, stale bool) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "synthetic summary test")
	if err != nil {
		t.Fatal(err)
	}
	item, err := p.CreateTest(ctx, w.ID, "synthetic", "")
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	draft := *session.Draft
	draft, err = p.SaveDraft(ctx, item.ID, session.ID, draft.Revision, "import { test } from '@playwright/test'; test('synthetic', async () => {});\n")
	if err != nil {
		t.Fatal("save synthetic draft", err)
	}
	if _, err = p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, NewID()); err == nil {
		t.Fatal("unvalidated draft summarized")
	}
	validation, err := p.ValidateDraft(ctx, item.ID, session.ID, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "m11w4-test", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m11w4-test", 1)
	if err != nil || a == nil || a.ID != validation.ID {
		t.Fatal("claim validation", err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	for name, body := range map[string]string{"report.html": "<html>synthetic validation</html>", "results.json": `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`} {
		artifact, e := files.Save(a.ID, a.AttemptID, name, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		if e = p.SaveArtifact(ctx, artifact); e != nil {
			t.Fatal(e)
		}
	}
	if err = p.Complete(ctx, "m11w4-test", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "m11w4-test", nil); err != nil {
		t.Fatal(err)
	}
	m11w4SetExternal(t, p, ctx, w.ID)
	summary, err := p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, validation.ID)
	if err != nil {
		t.Fatal("create summary", err)
	}
	m11w4Summary(t, p, ctx, w.ID, item.ID, session.ID, "", summary.ID, validation.ID, "test", stale)
}

func m11w4Summary(t *testing.T, p *Postgres, ctx context.Context, workspaceID, testID, sessionID, planID, runID, validationID, kind string, stale bool) {
	t.Helper()
	run, err := p.Run(ctx, runID)
	if err != nil || run.AuthorEngine != "external" {
		t.Fatal("summary engine was not snapshotted external", err)
	}
	_, secret, err := p.CreateAgentToken(ctx, workspaceID, "synthetic summary")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	handler := NewAPI(p, nil, engine, NewID(), log).WithAdminAccess(NewID(), "https://whippet.example").Handler(nil)
	postRaw := func(name string, arguments []byte) (map[string]any, bool) {
		t.Helper()
		payload := append([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+name+`","arguments":`), arguments...)
		payload = append(payload, []byte(`}}`)...)
		req := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer "+secret)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK && rec.Code != http.StatusBadRequest {
			t.Fatalf("unexpected MCP HTTP status %d; result is inconclusive", rec.Code)
		}
		var wire struct {
			Result struct {
				Structured map[string]any `json:"structuredContent"`
				IsError    bool           `json:"isError"`
			} `json:"result"`
			Error json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
			t.Fatal("invalid MCP response")
		}
		return wire.Result.Structured, rec.Code != 200 || wire.Result.IsError || len(wire.Error) != 0
	}
	post := func(name string, args any) (map[string]any, bool) {
		raw, e := json.Marshal(args)
		if e != nil {
			t.Fatal(e)
		}
		return postRaw(name, raw)
	}
	got, bad := post("task_claim", map[string]any{"requestId": NewID()})
	task, ok := got["task"].(map[string]any)
	if bad || !ok || task["runId"] != runID {
		t.Fatal("claim wrong summary run")
	}
	ids := map[string]any{"runId": task["runId"], "attemptId": task["attemptId"], "leaseId": task["leaseId"]}
	bundle, ok := task["contextBundle"].(map[string]any)
	if !ok {
		t.Fatal("missing context bundle")
	}
	author, ok := bundle["author"].(map[string]any)
	if !ok {
		t.Fatal("missing author")
	}
	tools, ok := author["allowedTools"].([]any)
	evidence, evidenceOK := author["validationEvidence"].(map[string]any)
	if !ok || len(tools) != 0 || !evidenceOK || evidence["runId"] != validationID || evidence["status"] != "succeeded" || evidence["reportsReady"] != true || author["skillId"] != "acceptance-summary" || bundle["skillUri"] != "whippet://skill/acceptance-summary/main" || bundle["externalReferenceUri"] != "whippet://skill/acceptance-summary/references/external-mcp" {
		t.Fatal("wrong summary scope or validation binding")
	}
	stats, statsOK := evidence["stats"].(map[string]any)
	if !statsOK || stats["expected"] != float64(1) || stats["unexpected"] != float64(0) {
		t.Fatal("validation stats missing")
	}
	switch kind {
	case "test":
		if author["moduleSummary"] != nil || author["batch"] != nil {
			t.Fatal("unexpected platform snapshot")
		}
	case "module":
		module, yes := author["moduleSummary"].(map[string]any)
		metadata, metadataOK := module["module"].(map[string]any)
		if !yes || !metadataOK || module["harnessHash"] != evidence["scriptHash"] || module["harnessHash"] != scriptHash(asString(metadata["harness"])) || module["bodyHash"] != scriptHash(asString(bundle["script"])) || !sha256Hex(asString(module["bundleHash"])) || author["batch"] != nil {
			t.Fatal("module evidence mismatch")
		}
	case "batch":
		batch, yes := author["batch"].(map[string]any)
		modules, has := batch["modules"].([]any)
		if !yes || !has || len(modules) != 1 || batch["planId"] != planID || !sha256Hex(asString(batch["batchHash"])) {
			t.Fatal("batch evidence mismatch")
		}
		candidate, candidateOK := modules[0].(map[string]any)
		moduleEvidence, moduleEvidenceOK := candidate["validationEvidence"].(map[string]any)
		if !candidateOK || !moduleEvidenceOK || candidate["mode"] != "candidate" || moduleEvidence["status"] != "succeeded" || moduleEvidence["reportsReady"] != true || candidate["harnessHash"] != moduleEvidence["scriptHash"] {
			t.Fatal("batch candidate evidence mismatch")
		}
	}
	nested := map[string]any{"runId": ids["runId"], "attemptId": ids["attemptId"], "leaseId": ids["leaseId"], "callId": NewID(), "name": "browser_snapshot", "arguments": map[string]any{}}
	if _, bad = post("task_tool_call", nested); !bad {
		t.Fatal("summary nested browser allowed")
	}
	output := map[string]any{"message": "synthetic", "description": "fixture coverage and limitations", "backgroundSummary": "synthetic state test only"}
	for _, field := range []string{"script", "requestValidation", "partial", "proof", "selfTestPassed", "unknown"} {
		invalid := map[string]any{}
		for k, v := range output {
			invalid[k] = v
		}
		invalid[field] = true
		args := map[string]any{"runId": ids["runId"], "attemptId": ids["attemptId"], "leaseId": ids["leaseId"], "submitId": NewID(), "output": invalid}
		if _, bad = post("task_submit", args); !bad {
			t.Fatalf("accepted forbidden summary field %s", field)
		}
	}
	duplicate := map[string]any{"runId": ids["runId"], "attemptId": ids["attemptId"], "leaseId": ids["leaseId"], "submitId": NewID(), "output": json.RawMessage(`{"message":"one","message":"two","description":"d","backgroundSummary":"b"}`)}
	if _, bad = post("task_submit", duplicate); !bad {
		t.Fatal("duplicate output key accepted")
	}
	// Refill the real per-token bucket before checking submit replay.
	time.Sleep(3100 * time.Millisecond)
	if stale {
		targetID, targetSession := testID, sessionID
		if kind == "batch" {
			batch := author["batch"].(map[string]any)
			modules := batch["modules"].([]any)
			candidate, yes := modules[0].(map[string]any)
			if !yes || candidate["mode"] != "candidate" {
				t.Fatal("missing batch candidate")
			}
			targetID, targetSession = asString(candidate["testId"]), asString(candidate["editingSessionId"])
		}
		current, e := p.Draft(ctx, targetID)
		if e != nil {
			t.Fatal("read draft for CAS", e)
		}
		if _, e = p.SaveDraft(ctx, targetID, targetSession, current.Revision, current.Script+"\n// changed after claim"); e != nil {
			t.Fatal("change draft for CAS", e)
		}
		args := map[string]any{"runId": ids["runId"], "attemptId": ids["attemptId"], "leaseId": ids["leaseId"], "submitId": NewID(), "output": output}
		_, rejected := post("task_submit", args)
		actual, e := p.Run(ctx, runID)
		if e != nil || actual.Status == "succeeded" {
			t.Fatal("stale summary applied", e)
		}
		if !rejected && !Terminal(actual.Status) {
			t.Fatal("stale summary neither rejected nor terminal")
		}
		if kind == "batch" {
			view, e := p.PlanSummary(ctx, planID)
			if e != nil || view == nil || (!view.Stale && view.PublishReady) {
				t.Fatal("stale batch became publishable", e)
			}
		} else {
			session, e := p.EditingSession(ctx, testID, sessionID)
			if e != nil || (session.Summary != nil && session.Summary.ValidForCurrentDraft) {
				t.Fatal("stale summary considered valid", e)
			}
		}
		return
	}
	submitID := NewID()
	args := map[string]any{"runId": ids["runId"], "attemptId": ids["attemptId"], "leaseId": ids["leaseId"], "submitId": submitID, "output": output}
	got, bad = post("task_submit", args)
	if bad || got["state"] != "submitted" || got["appliedRevision"] != nil || got["validationRunId"] != nil {
		t.Fatal("summary submit failed")
	}
	repeated, bad := post("task_submit", args)
	if bad || repeated["state"] != "submitted" {
		t.Fatal("identical submit not idempotent")
	}
	args["output"] = map[string]any{"message": "changed", "description": "fixture coverage and limitations", "backgroundSummary": "synthetic state test only"}
	if _, bad = post("task_submit", args); !bad {
		t.Fatal("changed replay accepted")
	}
	run, err = p.Run(ctx, runID)
	if err != nil || run.Status != "succeeded" {
		t.Fatal("summary did not succeed", err)
	}
	if kind == "batch" {
		view, e := p.PlanSummary(ctx, planID)
		if e != nil || view == nil || view.RunID != runID || view.Status != "succeeded" || view.Stale || view.Description == nil || len(view.Candidates) != 1 {
			t.Fatal("batch summary not bound", e)
		}
	} else {
		s, e := p.EditingSession(ctx, testID, sessionID)
		if e != nil || s == nil || s.Summary == nil || s.Summary.RunID != runID || !s.Summary.ValidForCurrentDraft || s.Summary.Description == nil {
			t.Fatal("summary not bound", e)
		}
	}
}

func asString(v any) string { s, _ := v.(string); return s }
