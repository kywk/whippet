//go:build integration

package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInspectionTerminalFeedAndLink(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	workspace, err := p.CreateWorkspace(ctx, "inspection fixture")
	if err != nil {
		t.Fatal(err)
	}
	const target = "https://inspection.example"
	config := WorkspaceConfig{
		Name: workspace.Name, DefaultTestURL: target + "/app",
		Targets:      []WorkspaceOrigin{{Name: "inspection target", Origin: target}},
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
	test, err := p.CreateTest(ctx, workspace.ID, "Published inspection fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	version := NewID()
	snapshot, _ := selectedContext(workspace, false)
	script := "published inspection fixture"
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions
		(id,test_id,version,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin)
		VALUES ($1,$2,1,$3,$4,$5,$6,$7,'manual')`, version, test.ID, script, scriptHash(script), workspace.TimeoutMS,
		settingsJSON(&WorkspaceSettings{Revision: workspace.Revision, Sites: []WorkspaceSite{}, DefaultTestURL: target + "/app", TimeoutMS: workspace.TimeoutMS}),
		jsonText(snapshot)); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, test.ID, version); err != nil {
		t.Fatal(err)
	}
	bridge := strings.Repeat("b", 43)
	scheduler := strings.Repeat("s", 43)
	qaConfig := &InspectionConfig{Sources: []inspectionSource{{
		WorkspaceID: workspace.ID, Environment: "qa", ProjectSlug: "qa-fixture", TargetOrigin: target,
		FeedbackOrigin: "https://feedback.example", BridgeTokenHash: scriptHash(bridge), ScheduleTokenHash: scriptHash(scheduler),
		Tests: []inspectionTest{{TestID: test.ID, VersionIDs: []string{version}, CheckKey: "title", TestTitle: "saved title", AssertionTitle: "title is visible"}},
	}}}
	if !qaConfig.valid() {
		t.Fatal("invalid test source fixture")
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(p, files, nil, "manager-fixture", log).WithAdminAccess(fixtureAdminKey, fixtureOrigin).WithInspectionConfig(qaConfig).Handler(nil)
	call := func(method, path, bearer, body string, expected int, dst any) {
		t.Helper()
		req := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(body))
		if bearer == fixtureAdminKey {
			req.Header.Set("X-Whippet-Admin-Token", bearer)
		} else if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != expected {
			t.Fatalf("%s %s returned %d, wanted %d: %s", method, path, response.Code, expected, response.Body.String())
		}
		if dst != nil && json.Unmarshal(response.Body.Bytes(), dst) != nil {
			t.Fatalf("invalid response body for %s %s", method, path)
		}
	}
	root := "/api/inspections/workspaces/" + workspace.ID + "/runs"
	bodyFor := func(id, environment, versionID string) string {
		return jsonText(map[string]string{"testId": test.ID, "versionId": versionID, "environment": environment, "requestId": id})
	}
	schedule := func(request, wanted string) string {
		t.Helper()
		var out struct {
			RunID string `json:"runId"`
		}
		call("POST", root, scheduler, bodyFor(request, "qa", version), 202, &out)
		if !ValidID(out.RunID) || wanted != "" && out.RunID != wanted {
			t.Fatalf("unexpected Run receipt %q", out.RunID)
		}
		return out.RunID
	}

	call("GET", root, scheduler, "", 403, nil)
	call("GET", root, "", "", 401, nil)
	call("GET", "/api/inspections/workspaces/"+NewID()+"/runs", bridge, "", 403, nil)
	call("POST", root, bridge, bodyFor(NewID(), "qa", version), 403, nil)
	call("POST", root, scheduler, bodyFor(NewID(), "wrong", version), 403, nil)
	call("POST", root, scheduler, bodyFor(NewID(), "qa", NewID()), 403, nil)
	firstOperation := NewID()
	first := schedule(firstOperation, "")
	second := schedule(NewID(), "")
	schedule(firstOperation, first)
	manual, err := p.CreateRun(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	const manager = "inspection-tests"
	if err = p.RegisterManager(ctx, manager, 4); err != nil {
		t.Fatal(err)
	}
	start := func(run string) *Assignment {
		t.Helper()
		item, err := p.Claim(ctx, manager, 4)
		if err != nil || item == nil || item.ID != run {
			t.Fatalf("Run not claimed in order: %v", err)
		}
		if err = p.AddEvent(ctx, manager, item.ID, item.AttemptID, Event{EventID: NewID(), Kind: "started"}); err != nil {
			t.Fatal(err)
		}
		return item
	}
	failure := start(first)
	later := start(second)
	outside := start(manual.ID)

	finish := func(item *Assignment, result Result, proof bool) {
		t.Helper()
		if proof {
			data := map[string]string{
				"report.html":  "<!doctype html><h1>fixture report</h1>",
				"results.json": `{"stats":{"expected":0,"unexpected":1},"errors":[]}`,
			}
			for name, payload := range data {
				artifact, err := files.Save(item.ID, item.AttemptID, name, strings.NewReader(payload))
				if err != nil {
					t.Fatal(err)
				}
				if err := p.SaveArtifact(ctx, artifact); err != nil {
					t.Fatal(err)
				}
			}
		}
		if err := p.Complete(ctx, manager, item.ID, item.AttemptID, result); err != nil {
			t.Fatal(err)
		}
	}
	finish(later, Result{Status: "failed", Error: "runner interrupted"}, false)
	var page inspectionPage
	call("GET", root+"?limit=1", bridge, "", 200, &page)
	if len(page.Items) != 1 || page.Items[0].RunID != second || page.Items[0].Outcome != "infrastructure" || page.NextCursor == "" {
		t.Fatalf("first terminal page mismatch: %+v", page)
	}
	cursor := page.NextCursor
	proof := Result{Status: "failed", TargetOrigin: target, Assertion: scriptHash("saved title\x00title is visible")}
	finish(failure, proof, true)
	finish(outside, proof, true)
	call("GET", root+"/"+manual.ID, bridge, "", 404, nil)
	page = inspectionPage{}
	call("GET", root+"?after="+cursor, bridge, "", 200, &page)
	if len(page.Items) != 1 || page.Items[0].RunID != first || page.NextCursor == cursor ||
		page.Items[0].Outcome != "assertion_failed" || page.Items[0].StartedAt == nil ||
		page.Items[0].ReportURL != "/api/runs/"+first+"/artifacts/report.html" || page.Items[0].CheckKey != "title" {
		t.Fatalf("late-finishing assertion evidence mismatch: %+v", page)
	}
	var evidence terminalInspectionRun
	call("GET", root+"/"+first, bridge, "", 200, &evidence)
	if evidence.AttemptID == nil || *evidence.AttemptID != failure.AttemptID ||
		evidence.VersionID != version || evidence.FailureSignature != page.Items[0].FailureSignature {
		t.Fatalf("detail evidence mismatch: %+v", evidence)
	}
	call("GET", evidence.ReportURL, bridge, "", 403, nil)
	call("GET", evidence.ReportURL, "", "", 401, nil)
	call("GET", evidence.ReportURL, fixtureAdminKey, "", 200, nil)
	call("POST", "/api/tests/"+test.ID+"/publish", bridge, "{}", 403, nil)

	reportID := NewID()
	bodyLink := func(attempt, project, report string) string {
		return jsonText(map[string]string{"attemptId": attempt, "projectSlug": project, "reportPublicId": report})
	}
	linkPath := root + "/" + first + "/links"
	call("POST", linkPath, bridge, bodyLink(NewID(), "qa-fixture", reportID), 409, nil)
	call("POST", linkPath, bridge, bodyLink(failure.AttemptID, "other", reportID), 403, nil)
	call("POST", root+"/"+second+"/links", bridge, bodyLink(later.AttemptID, "qa-fixture", reportID), 409, nil)
	linkBody := bodyLink(failure.AttemptID, "qa-fixture", reportID)
	var receipt, replay inspectionLink
	call("POST", linkPath, bridge, linkBody, 200, &receipt)
	call("POST", linkPath, bridge, linkBody, 200, &replay)
	if receipt != replay || receipt.RunID != first || receipt.WorkspaceID != workspace.ID || receipt.ReportPublicID != reportID {
		t.Fatalf("unexpected link receipt: %+v", receipt)
	}
	call("POST", linkPath, bridge, bodyLink(failure.AttemptID, "qa-fixture", NewID()), 409, nil)
	var linked Run
	call("GET", "/api/runs/"+first, fixtureAdminKey, "", 200, &linked)
	if linked.FeedbackReportURL != "https://feedback.example/p/qa-fixture/reports/"+reportID {
		t.Fatalf("linked Run did not expose the canonical report path: %+v", linked)
	}
}

// The real inspection Runner is covered by cross-service smoke. This fixture
// exercises the separate QA publication boundary with saved validation evidence.
func TestInspectionQAPublicationGuard(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	manualSeedVersions(t, p, ctx)
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	h := m7DBHarness{t: t, p: p, ctx: ctx, files: files}
	if err := p.RegisterManager(ctx, "m7-test", 1); err != nil {
		t.Fatal(err)
	}
	const testID = "10000000-0000-4000-8000-000000000001"
	session, _, err := p.StartEditingSession(ctx, testID)
	if err != nil {
		t.Fatal(err)
	}
	validateAndSummarize := func(draft Draft) (string, string) {
		t.Helper()
		validation, err := p.ValidateDraft(ctx, testID, session.ID, draft.Revision)
		if err != nil {
			t.Fatal(err)
		}
		a := h.claim(validation.ID)
		h.upload(a, "report.html", "<!doctype html><h1>fixture validation passed</h1>")
		h.upload(a, "results.json", `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`)
		h.complete(a, "succeeded")
		h.release()
		summary, err := p.CreateSummary(ctx, testID, session.ID, draft.Revision, validation.ID)
		if err != nil {
			t.Fatal(err)
		}
		a = h.claim(summary.ID)
		h.upload(a, "author.json", `{"message":"請確認","description":"Verify the saved title","backgroundSummary":"Approved publication fixture"}`)
		h.complete(a, "succeeded")
		h.release()
		return validation.ID, summary.ID
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(p, files, nil, "manager-fixture", log).WithAdminAccess(fixtureAdminKey, fixtureOrigin).Handler(nil)
	login := httptest.NewRequest("POST", fixtureOrigin+"/api/dev-login", strings.NewReader(`{"userId":"dev-qa"}`))
	login.Header.Set("X-Whippet-Admin-Token", fixtureAdminKey)
	login.Header.Set("Origin", fixtureOrigin)
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, login)
	cookies := loginResponse.Result().Cookies()
	if loginResponse.Code != 200 || len(cookies) != 1 {
		t.Fatalf("QA session unavailable: %d", loginResponse.Code)
	}
	publish := func(revision int, summary string, confirmed bool, expected int) Version {
		t.Helper()
		body := jsonText(map[string]any{"editingSessionId": session.ID, "revision": revision, "summaryRunId": summary, "confirmed": confirmed})
		req := httptest.NewRequest("POST", fixtureOrigin+"/api/tests/"+testID+"/publish", strings.NewReader(body))
		req.Header.Set("Origin", fixtureOrigin)
		req.AddCookie(cookies[0])
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != expected {
			t.Fatalf("publish revision %d: got %d want %d: %s", revision, response.Code, expected, response.Body.String())
		}
		var version Version
		if expected == 201 && json.Unmarshal(response.Body.Bytes(), &version) != nil {
			t.Fatal("published version response unavailable")
		}
		return version
	}

	original := *session.Draft
	publish(original.Revision, NewID(), true, 409)
	_, oldSummary := validateAndSummarize(original)
	revised, err := p.SaveDraft(ctx, testID, session.ID, original.Revision, original.Script+"\n// A new draft revision")
	if err != nil || revised.Revision <= original.Revision || revised.ValidationRunID != nil {
		t.Fatalf("revised draft retained stale validation: %+v, %v", revised, err)
	}
	publish(original.Revision, oldSummary, true, 409)
	publish(revised.Revision, oldSummary, true, 409)
	validation, summary := validateAndSummarize(revised)
	publish(revised.Revision, oldSummary, true, 409)
	publish(revised.Revision, summary, false, 400)
	version := publish(revised.Revision, summary, true, 201)
	retry := publish(revised.Revision, summary, true, 201)
	if !ValidID(version.ID) || version.ID != retry.ID || version.Script != revised.Script ||
		version.ValidationRunID == nil || *version.ValidationRunID != validation ||
		version.SummaryRunID == nil || *version.SummaryRunID != summary {
		t.Fatalf("QA published a version without the matching evidence: %+v", version)
	}
}
