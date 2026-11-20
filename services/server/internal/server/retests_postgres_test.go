//go:build integration

package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDeploymentRetestBinding(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	workspace, err := p.CreateWorkspace(ctx, "deployment fixture")
	if err != nil {
		t.Fatal(err)
	}
	const target = "http://deployment.example"
	config := WorkspaceConfig{
		Name: workspace.Name, DefaultTestURL: target + "/app",
		Targets:      []WorkspaceOrigin{{Name: "deployment target", Origin: target}},
		Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{}, TimeoutMS: 15000,
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',
		authorization_revision=1,canonical_config=$2 WHERE id=$1`, workspace.ID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	workspace, err = p.Workspace(ctx, workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	item, err := p.CreateTest(ctx, workspace.ID, "Todo title", "")
	if err != nil {
		t.Fatal(err)
	}
	version, staleVersion := NewID(), NewID()
	snapshot, _ := selectedContext(workspace, false)
	for i, id := range []string{staleVersion, version} {
		script := "deployment test fixture"
		if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions
			(id,test_id,version,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual')`, id, item.ID, i+1, script, scriptHash(script), workspace.TimeoutMS,
			settingsJSON(&WorkspaceSettings{Revision: workspace.Revision, Sites: []WorkspaceSite{},
				DefaultTestURL: target + "/app", TimeoutMS: workspace.TimeoutMS}), jsonText(snapshot)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, item.ID, version); err != nil {
		t.Fatal(err)
	}
	bridge, scheduler := strings.Repeat("b", 43), strings.Repeat("s", 43)
	approved := inspectionTest{TestID: item.ID, VersionIDs: []string{version, staleVersion}, CheckKey: "blank",
		TestTitle: "save title", AssertionTitle: "ignores blank",
		RetestChecks: []retestCheckConfig{{CheckKey: "trim", TestTitle: "save title", AssertionTitle: "trims input"}}}
	source := inspectionSource{WorkspaceID: workspace.ID, Environment: "qa", ProjectSlug: "sandbox-todomvc", TargetOrigin: target,
		DeploymentProofPath: "/.well-known/deployment.json", FeedbackOrigin: "https://feedback.example",
		BridgeTokenHash: scriptHash(bridge), ScheduleTokenHash: scriptHash(scheduler), Tests: []inspectionTest{approved}}
	cfg := &InspectionConfig{Sources: []inspectionSource{source}}
	if !cfg.valid() {
		t.Fatal("invalid retest fixture config")
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(p, files, nil, "fixture-manager", log).WithInspectionConfig(cfg).Handler(nil)
	call := func(method, path, bearer, body string, expected int, dst any) {
		t.Helper()
		req := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(body))
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != expected {
			t.Fatalf("%s %s: got %d, wanted %d: %s", method, path, w.Code, expected, w.Body.String())
		}
		if dst != nil && json.Unmarshal(w.Body.Bytes(), dst) != nil {
			t.Fatal("invalid response")
		}
	}
	route := "/api/retests/workspaces/" + workspace.ID + "/runs"
	body := func(deployment, artifact, versionID string, keys ...string) string {
		return jsonText(map[string]any{"testId": item.ID, "versionId": versionID, "environment": "qa",
			"deploymentId": deployment, "artifactRevision": artifact, "checkKeys": keys})
	}
	const artifact = "artifact-real"
	runFor := func(deployment string) string {
		t.Helper()
		var out struct {
			RunID string `json:"runId"`
		}
		call("POST", route, scheduler, body(deployment, artifact, version, "blank", "trim"), 202, &out)
		if !ValidID(out.RunID) {
			t.Fatal("missing Run receipt")
		}
		return out.RunID
	}
	call("POST", route, bridge, body("deploy-a", artifact, version, "blank"), 403, nil)
	call("POST", route, scheduler, body("deploy-a", artifact, staleVersion, "blank"), 409, nil)
	call("POST", route, scheduler, body("deploy-a", artifact, version, "trim", "blank"), 400, nil)
	call("POST", route, scheduler, body("deploy-a", artifact, version, "unknown"), 403, nil)
	first := runFor("deploy-a")
	if runFor("deploy-a") != first {
		t.Fatal("deployment and test schedule created more than one Run")
	}
	call("POST", route, scheduler, body("deploy-a", "wrong", version, "blank", "trim"), 409, nil)
	call("POST", route, scheduler, body("deploy-a", artifact, version, "trim"), 409, nil)
	call("GET", route+"/"+first, scheduler, "", 403, nil)
	call("GET", route+"/"+first, bridge, "", 409, nil)
	second, third, fourth := runFor("deploy-b"), runFor("deploy-c"), runFor("deploy-d")
	if _, err = p.Cancel(ctx, fourth); err != nil {
		t.Fatal(err)
	}
	const manager = "retest-tests"
	if err = p.RegisterManager(ctx, manager, 3); err != nil {
		t.Fatal(err)
	}
	finish := func(runID, deployment, status string, verified bool, checks map[string]string) {
		t.Helper()
		a, err := p.Claim(ctx, manager, 3)
		if err != nil || a == nil || a.ID != runID || a.Retest == nil || a.Retest.DeploymentID != deployment ||
			a.Retest.ArtifactRevision != artifact || a.Retest.Origin != target || a.Retest.ProofPath != source.DeploymentProofPath {
			t.Fatalf("missing frozen assignment: %+v, %v", a, err)
		}
		if err = p.AddEvent(ctx, manager, a.ID, a.AttemptID, Event{EventID: NewID(), Kind: "started"}); err != nil {
			t.Fatal(err)
		}
		data := `{"stats":{"expected":1,"unexpected":0},"errors":[]}`
		if status == "failed" {
			data = `{"stats":{"expected":0,"unexpected":1},"errors":[]}`
		}
		for name, body := range map[string]string{"report.html": "<!doctype html><h1>retest</h1>", "results.json": data} {
			file, err := files.Save(a.ID, a.AttemptID, name, strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if err = p.SaveArtifact(ctx, file); err != nil {
				t.Fatal(err)
			}
		}
		result := Result{Status: status, Retest: &retestObservation{deployment, artifact, verified, checks}}
		if err = p.Complete(ctx, manager, a.ID, NewID(), result); !errors.Is(err, ErrConflict) {
			t.Fatal("unknown attempt supplied retest proof", err)
		}
		if err = p.Complete(ctx, manager, a.ID, a.AttemptID, result); err != nil {
			t.Fatal(err)
		}
		// A replay from the same attempt cannot replace the first result proof.
		result.Retest = &retestObservation{DeploymentID: deployment, ArtifactRevision: artifact}
		if err = p.Complete(ctx, manager, a.ID, a.AttemptID, result); err != nil {
			t.Fatal(err)
		}
	}
	checks := approved.checks()
	finish(first, "deploy-a", "succeeded", true, map[string]string{checks["blank"]: "passed", checks["trim"]: "passed"})
	finish(second, "deploy-b", "succeeded", true, map[string]string{checks["trim"]: "passed"})
	finish(third, "deploy-c", "failed", true, map[string]string{checks["blank"]: "failed"})
	for _, run := range []struct {
		id, deployment, outcome, blank, trim string
		report                               bool
	}{
		{first, "deploy-a", "passed", "passed", "passed", true},
		{second, "deploy-b", "unverified", "skipped", "passed", false},
		{third, "deploy-c", "assertion_failed", "failed", "skipped", true},
		{fourth, "deploy-d", "cancelled", "skipped", "skipped", false},
	} {
		var data deploymentRetestRun
		call("GET", route+"/"+run.id, bridge, "", 200, &data)
		if data.Purpose != "deployment_retest" || data.RunID != run.id || data.Environment != "qa" ||
			data.DeploymentID != run.deployment || data.ArtifactRevision != artifact || data.VersionID != version ||
			data.Outcome != run.outcome || len(data.Checks) != 2 ||
			data.Checks[0] != (retestCheckResult{"blank", run.blank}) || data.Checks[1] != (retestCheckResult{"trim", run.trim}) ||
			(data.ReportURL != "") != run.report || data.FinishedAt.IsZero() {
			t.Fatalf("unexpected result: %+v", data)
		}
		if run.outcome == "cancelled" && (data.AttemptGeneration != 0 || data.AttemptID != nil || data.StartedAt != nil) {
			t.Fatalf("invented attempt for cancelled run: %+v", data)
		}
		if run.outcome != "cancelled" && (data.AttemptGeneration != 1 || data.AttemptID == nil || data.StartedAt == nil) {
			t.Fatalf("missing actual attempt: %+v", data)
		}
	}
	var inspection inspectionPage
	call("GET", "/api/inspections/workspaces/"+workspace.ID+"/runs", bridge, "", 200, &inspection)
	if len(inspection.Items) != 0 {
		t.Fatal("retests must never enter the inspection feed")
	}
}
