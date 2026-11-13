//go:build integration

package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func m10PlanFixture(t *testing.T) (*Postgres, context.Context, Test, EditingSession, PlanStageInput) {
	t.Helper()
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "plan")
	if err != nil {
		t.Fatal(err)
	}
	slug := "setup"
	module, err := p.CreatePlatformTest(ctx, w.ID, "setup", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	metadata := Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare", Harness: m10BundleSpec}
	version := NewID()
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings,module,script_origin) VALUES($1,$2,1,$3,60000,$4,$5,'manual')`, version, module.ID, m10BundleModule, settingsJSON(&w.WorkspaceSettings), jsonText(metadata)); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, module.ID, version); err != nil {
		t.Fatal(err)
	}
	test, err := p.CreatePlatformTest(ctx, w.ID, "usecase", "", "usecase", nil)
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	return p, ctx, test, session, PlanStageInput{ID: "prepare", Title: "Stage 1: prepare", Action: "reuse", ModuleVersionID: version, Args: map[string]StageArgument{}}
}
func TestM10PostgresPlanConfirmCancelAndLateResult(t *testing.T) {
	p, ctx, item, session, first := m10PlanFixture(t)
	if plan, err := p.Plan(ctx, item.ID, session.ID); err != nil || plan != nil {
		t.Fatal("GET created Plan", err)
	}
	second := first
	second.ID = "verify"
	second.Title = "Stage 2: verify"
	second.Args = map[string]StageArgument{"name": {Kind: "binding", StageID: first.ID, Path: []string{"name"}}}
	plan, err := p.SavePlan(ctx, item.ID, session.ID, session.Draft.Revision, 0, []PlanStageInput{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Revision != 1 || plan.Status != "draft" || plan.Stages[0].ModuleTestID == "" {
		t.Fatal("Plan snapshot invalid")
	}
	if _, err = p.SavePlan(ctx, item.ID, session.ID, session.Draft.Revision, 0, []PlanStageInput{first}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale Plan overwrite accepted", err)
	}
	var wg sync.WaitGroup
	confirmed := make([]*Plan, 2)
	errs := make([]error, 2)
	for i := range confirmed {
		wg.Add(1)
		go func(i int) { defer wg.Done(); confirmed[i], errs[i] = p.ConfirmPlan(ctx, plan.ID, plan.Revision) }(i)
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil || confirmed[0].ValidationRunID == nil || stringValue(confirmed[0].ValidationRunID) != stringValue(confirmed[1].ValidationRunID) {
		t.Fatalf("concurrent confirm %+v", errs)
	}
	current := confirmed[0]
	if current.Status != "composed" || current.BaseRevision != session.Draft.Revision+1 {
		t.Fatal("compose state/revision incorrect")
	}
	d, err := p.Draft(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(d.Script, "test.step(") != 2 || !strings.Contains(d.Script, `_stage0["name"]`) || strings.Contains(d.Script, "as prepare") {
		t.Fatal("deterministic step/binding code missing")
	}
	if _, err = p.ConfirmPlan(ctx, plan.ID, current.Revision+1); !errors.Is(err, ErrConflict) {
		t.Fatal("wrong confirm revision accepted", err)
	}
	if err = p.RegisterManager(ctx, "m10-plan", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m10-plan", 1)
	if err != nil || a == nil || len(a.Files) != 2 {
		t.Fatal("Plan bundle not dispatched", err)
	}
	stopped, err := p.CancelPlan(ctx, plan.ID, current.Revision)
	if err != nil || stopped.Status != "stopped" {
		t.Fatal("cancel failed", err)
	}
	again, err := p.CancelPlan(ctx, plan.ID, current.Revision)
	if err != nil || again.Revision != stopped.Revision {
		t.Fatal("cancel replay failed", err)
	}
	var released bool
	if err = p.DB.QueryRowContext(ctx, `SELECT slot_released FROM runs WHERE id=$1`, a.ID).Scan(&released); err != nil || released {
		t.Fatal("cancel released Worker slot", err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	for name, body := range map[string]string{"report.html": "<html>synthetic state test</html>", "results.json": "{}"} {
		artifact, err := files.Save(a.ID, a.AttemptID, name, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatal(err)
		}
	}
	if err = p.Complete(ctx, "m10-plan", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	actual, err := p.Plan(ctx, item.ID, session.ID)
	if err != nil || actual.Status != "stopped" || actual.Revision != stopped.Revision {
		t.Fatal("late success advanced cancelled Plan", err)
	}
	if _, err = p.ConfirmPlan(ctx, plan.ID, plan.Revision); err != nil {
		t.Fatal("original confirm replay failed", err)
	}
	var runs int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1`, item.ID).Scan(&runs); err != nil || runs != 1 {
		t.Fatal("confirm replay requeued", err)
	}
}
func TestM10PostgresPlanFailureAndClosedCapabilities(t *testing.T) {
	p, ctx, item, session, stage := m10PlanFixture(t)
	plan, err := p.SavePlan(ctx, item.ID, session.ID, session.Draft.Revision, 0, []PlanStageInput{stage})
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "m10-failed-plan", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m10-failed-plan", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	if err = p.Complete(ctx, "m10-failed-plan", a.ID, a.AttemptID, Result{Status: "failed", Error: "stage failed"}); err != nil {
		t.Fatal(err)
	}
	stopped, err := p.Plan(ctx, item.ID, session.ID)
	if err != nil || stopped.Status != "stopped" || stopped.Revision <= confirmed.Revision {
		t.Fatal("failure did not stop Plan", err)
	}
	if _, err = p.ConfirmPlan(ctx, plan.ID, stopped.Revision); !errors.Is(err, ErrConflict) {
		t.Fatal("stopped Plan silently restarted", err)
	}
	// Modify records planning intent but cannot take over a Module editing session.
	stage.Action = "modify"
	moduleSession, _, err := p.StartEditingSession(ctx, stopped.Stages[0].ModuleTestID)
	if err != nil {
		t.Fatal(err)
	}
	revised, err := p.SavePlan(ctx, item.ID, session.ID, stopped.BaseRevision, stopped.Revision, []PlanStageInput{stage})
	if err != nil {
		t.Fatal(err)
	}
	blocked, err := p.ConfirmPlan(ctx, plan.ID, revised.Revision)
	if err != nil || blocked.Status != "stopped" {
		t.Fatal("active Module session did not stop dispatch", err)
	}
	existing, err := p.EditingSession(ctx, moduleSession.TestID, moduleSession.ID)
	if err != nil || existing.Status != "active" {
		t.Fatal("Module session was taken over", err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	defer engine.Close()
	handler := NewAPI(p, nil, engine, "synthetic", log).Handler(nil)
	request := httptest.NewRequest("POST", "http://server/api/plans/"+plan.ID+"/publish", strings.NewReader(jsonText(map[string]any{"planRevision": revised.Revision, "confirmed": true, "summaryRunId": NewID()})))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 409 {
		t.Fatal("batch publish opened", response.Code)
	}
	// Writable Stage inputs never accept server status/Run IDs.
	request = httptest.NewRequest("PUT", "http://server/api/tests/"+item.ID+"/plan", strings.NewReader(jsonText(map[string]any{"editingSessionId": session.ID, "revision": revised.BaseRevision, "planRevision": revised.Revision, "stages": []any{map[string]any{"id": "x", "title": "x", "action": "reuse", "args": map[string]any{}, "status": "ready", "moduleVersionId": stage.ModuleVersionID}}})))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 400 {
		t.Fatal("caller wrote Stage status", response.Code)
	}
	request = httptest.NewRequest("GET", "http://server/api/tests/"+item.ID+"/plan?editingSessionId="+session.ID, nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var envelope struct {
		Plan *Plan `json:"plan"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &envelope) != nil || envelope.Plan == nil {
		t.Fatal("Plan envelope missing")
	}
}
