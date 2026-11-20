//go:build integration

package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestWorkspaceRunActivityPostgres(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	const workspaceID = "00000000-0000-4000-8000-000000000001"
	const publishedID = "10000000-0000-4000-8000-000000000001"
	const archivedID = "10000000-0000-4000-8000-000000000002"
	other, err := p.CreateWorkspace(ctx, "Scope isolation")
	if err != nil {
		t.Fatal(err)
	}
	draft, err := p.CreateTest(ctx, workspaceID, "Active draft", "")
	if err != nil {
		t.Fatal(err)
	}
	editor, _, err := p.StartEditingSession(ctx, draft.ID)
	if err != nil || editor.Draft == nil {
		t.Fatal("open draft", err)
	}
	foreign, err := p.CreateTest(ctx, other.ID, "Other Workspace draft", "")
	if err != nil {
		t.Fatal(err)
	}
	otherEditor, _, err := p.StartEditingSession(ctx, foreign.ID)
	if err != nil || otherEditor.Draft == nil {
		t.Fatal("open other draft", err)
	}
	const manager = "run-activity-fixture"
	if err := p.RegisterManager(ctx, manager, 1); err != nil {
		t.Fatal(err)
	}
	addRun := func(testID, kind, status, created string, session *EditingSession, skill string, partial, attempt *string) string {
		t.Helper()
		id := NewID()
		var revision *int
		var sessionID *string
		if session != nil {
			revision = &session.Draft.Revision
			sessionID = &session.ID
		}
		var payload any
		if kind == "author" {
			payload = jsonText(map[string]string{"skillId": skill})
		}
		var managerID *string
		if attempt != nil {
			managerID = stringPointer(manager)
		}
		if _, err := p.DB.ExecContext(ctx, `INSERT INTO runs
 (id,test_id,workspace_id,version_id,script_snapshot,script_hash,timeout_ms,workspace_settings,editing_session_id,draft_revision,
  kind,status,created_at,started_at,finished_at,author_payload,author_partial,attempt_id,manager_id,error)
 SELECT $1,t.id,t.workspace_id,CASE WHEN $2='run' THEN t.published_version_id END,'fixture','fixture',60000,w.settings,$3,$4,
  $2,$5,$6::timestamptz,$6::timestamptz+interval '1 second',
  CASE WHEN $5 IN ('failed','succeeded') THEN $6::timestamptz+interval '2 seconds' END,$7,$8,$9,$10,'full history diagnostic'
 FROM tests t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=$11`, id, kind, sessionID, revision, status, created, payload, partial, attempt, managerID, testID); err != nil {
			t.Fatal(err)
		}
		return id
	}
	const earlier = "2026-11-20T10:00:00+08:00"
	const later = "2026-11-20T11:00:00+08:00"
	formalAttempt, authorAttempt, activeAttempt := NewID(), NewID(), NewID()
	formal := addRun(publishedID, "run", "succeeded", later, nil, "", nil, &formalAttempt)
	addRun(archivedID, "run", "succeeded", later, nil, "", nil, nil)
	partial := addRun(draft.ID, "author", "succeeded", later, &editor, "test-author", stringPointer(`{"reason":"budget_exhausted","nextStep":"full continuation guidance"}`), &authorAttempt)
	reply := addRun(draft.ID, "author", "succeeded", later, &editor, "test-author", nil, nil)
	validation := addRun(draft.ID, "validation", "failed", later, &editor, "", nil, nil)
	summary := addRun(draft.ID, "author", "succeeded", later, &editor, "acceptance-summary", nil, nil)
	active := addRun(draft.ID, "author", "running", earlier, &editor, "test-author", nil, &activeAttempt)
	addRun(foreign.ID, "validation", "failed", later, &otherEditor, "", nil, nil)
	if err := p.ArchiveTest(ctx, archivedID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `INSERT INTO artifacts(run_id,attempt_id,name,storage_key,size_bytes,sha256)
 VALUES($1,$2,'report.html','report',1,'fixture')`, formal, formalAttempt); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id)
 VALUES($1,$2,'assistant','fixture response',$3)`, NewID(), editor.ConversationID, reply); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `INSERT INTO run_events(run_id,event_id,attempt_id,kind,message,created_at)
 VALUES($1,'late',$2,'log','active second',$5),($1,'early',$2,'log','active first',$6),
 ($1,'old',$3,'log','stale attempt',$6),($1,'start',$2,'started','started',$6),($4,'terminal',$3,'log','terminal log',$6)`,
		active, activeAttempt, authorAttempt, partial, later, earlier); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2`, other.ID, developmentQA); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(p, nil, nil, "fixture-manager", log).WithAdminAccess(fixtureAdminKey, fixtureOrigin).Handler(nil)
	call := func(method, path, body string, cookie *http.Cookie, expectedStatus int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(body))
		r.Header.Set("Origin", fixtureOrigin)
		if method == http.MethodPost {
			r.Header.Set("X-Whippet-Admin-Token", fixtureAdminKey)
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != expectedStatus {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, w.Code, expectedStatus, w.Body)
		}
		return w
	}
	qa := call("POST", "/api/dev-login", `{"userId":"dev-qa"}`, nil, 200).Result().Cookies()[0]
	path := "/api/workspaces/" + workspaceID + "/run-activity"
	items := func(path string) []map[string]any {
		t.Helper()
		var response struct{ Items []map[string]any }
		if err := json.Unmarshal(call("GET", path, "", qa, 200).Body.Bytes(), &response); err != nil || response.Items == nil {
			t.Fatal("expected items array", err)
		}
		return response.Items
	}
	all := items(path)
	order := []string{active, summary, validation, reply, partial, formal}
	if len(all) != len(order) {
		t.Fatalf("got %d visible runs, want %d", len(all), len(order))
	}
	for i, id := range order {
		if all[i]["id"] != id {
			t.Fatalf("queue order at %d: got %v, want %s", i, all[i]["id"], id)
		}
	}
	if all[1]["authorMode"] != "summary" || all[3]["authorRepliedOnly"] != true ||
		all[5]["reportUrl"] != "/api/runs/"+formal+"/artifacts/report.html" ||
		!reflect.DeepEqual(all[0]["progressEvents"], []any{"active first", "active second"}) {
		t.Fatal("lost report, active trail, summary mode, or conversational reply")
	}
	byID := map[string]map[string]any{}
	for _, testID := range []string{publishedID, draft.ID} {
		for _, run := range items("/api/tests/" + testID + "/runs") {
			byID[run["id"].(string)] = run
		}
	}
	if byID[formal]["versionId"] == nil || byID[formal]["workspaceSettings"] == nil || !reflect.DeepEqual(byID[partial]["progressEvents"], []any{"terminal log"}) {
		t.Fatal("single test history no longer returns details")
	}
	fields := strings.Fields("id testId status kind createdAt startedAt finishedAt editingSessionId draftRevision reportUrl authorMode authorEngine authorPartial authorRepliedOnly progressEvents")
	for i, id := range order {
		full := byID[id]
		projected := map[string]any{}
		for _, field := range fields {
			if value, ok := full[field]; ok {
				projected[field] = value
			}
		}
		if detail, ok := projected["authorPartial"].(map[string]any); ok {
			projected["authorPartial"] = map[string]any{"reason": detail["reason"]}
		}
		if id != active {
			delete(projected, "progressEvents")
		}
		if !reflect.DeepEqual(all[i], projected) {
			t.Fatalf("activity and detailed history diverged for %s", id)
		}
	}
	filter := url.Values{"testId": {foreign.ID, archivedID, NewID(), publishedID, publishedID}}
	if filtered := items(path + "?" + filter.Encode()); len(filtered) != 1 || filtered[0]["id"] != formal {
		t.Fatal("filter returned archived, unknown, duplicate, or foreign rows")
	}
	if got := items(path + "?testId=" + foreign.ID); len(got) != 0 {
		t.Fatal("foreign Test was visible")
	}
	if got := items(path + "?" + strings.Repeat("testId="+publishedID+"&", maxRunActivityTestIDs)); len(got) != 1 {
		t.Fatal("maximum number of filter values rejected or duplicated")
	}
	call("GET", path+"?"+strings.Repeat("testId="+publishedID+"&", maxRunActivityTestIDs+1), "", qa, 400)
	call("GET", path+"?testId=", "", qa, 400)
	call("GET", path+"?testId=%zz", "", qa, 400)
	call("GET", path+"?workspaceId="+other.ID, "", qa, 404)
	call("GET", "/api/workspaces/"+other.ID+"/run-activity", "", qa, 404)
	call("GET", path, "", nil, 401)
}
