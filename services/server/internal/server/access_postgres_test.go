//go:build integration

package server

import (
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

func TestPlatformRolesPostgres(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	manualSeedVersions(t, p, ctx)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	defer engine.Close()
	viewing := make(chan struct{}, 1)
	viewer := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewing <- struct{}{}
		<-r.Context().Done()
		w.WriteHeader(http.StatusNoContent)
	})
	handler := NewAPI(p, nil, engine, "fixture-manager", log).WithAdminAccess(fixtureAdminKey, fixtureOrigin).
		WithLiveHandlers(viewer, nil).Handler(nil)
	call := func(method, path, body, adminKey string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(body))
		if strings.HasSuffix(path, "/live") {
			viewerContext, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			r = r.WithContext(viewerContext)
		}
		r.Header.Set("Origin", fixtureOrigin)
		if adminKey != "" {
			r.Header.Set("X-Whippet-Admin-Token", adminKey)
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	check := func(response *httptest.ResponseRecorder, want int) *httptest.ResponseRecorder {
		t.Helper()
		if response.Code != want {
			t.Fatalf("got %d want %d: %s", response.Code, want, response.Body)
		}
		return response
	}
	login := func(id string) *http.Cookie {
		t.Helper()
		return check(call("POST", "/api/dev-login", jsonText(map[string]string{"userId": id}), fixtureAdminKey, nil), 200).Result().Cookies()[0]
	}
	qa, workspaceAdminCookie := login(developmentQA), login(developmentWorkspaceAdmin)
	site, super := login("dev-site-admin"), login(developmentAdmin)
	const seedWorkspace = "/api/workspaces/00000000-0000-4000-8000-000000000001"
	const seedTest = "/api/tests/10000000-0000-4000-8000-000000000001"
	var saved struct {
		Items []Workspace `json:"items"`
	}
	initial := check(call("GET", "/api/workspaces", "", "", qa), 200)
	if err := json.Unmarshal(initial.Body.Bytes(), &saved); err != nil || len(saved.Items) != 1 || saved.Items[0].Permissions == nil ||
		!saved.Items[0].Permissions.ManageTests || saved.Items[0].Permissions.ManageSettings || saved.Items[0].ConversationID != "" {
		t.Fatalf("seed membership or QA projection incorrect: %s", initial.Body)
	}

	created := check(call("POST", "/api/workspaces", `{"name":"Role test Workspace"}`, "", site), 201)
	var workspace Workspace
	if err := json.Unmarshal(created.Body.Bytes(), &workspace); err != nil || workspace.Permissions == nil || !workspace.Permissions.ManageWorkspaceAdmins || workspace.Permissions.ManageAgentTokens {
		t.Fatalf("Workspace creation or Site Admin permissions incorrect: %s", created.Body)
	}
	createdPath := "/api/workspaces/" + workspace.ID
	check(call("GET", createdPath, "", "", qa), 200)
	check(call("GET", createdPath+"/conversation", "", "", workspaceAdminCookie), 200)
	check(call("POST", "/api/workspaces", `{"name":"Denied"}`, "", qa), 403)
	check(call("POST", "/api/workspaces", `{"name":"Denied"}`, "", workspaceAdminCookie), 403)
	check(call("GET", "/api/users", "", "", workspaceAdminCookie), 403)
	check(call("GET", "/api/users", "", "", site), 200)
	check(call("GET", createdPath+"/members", "", "", qa), 403)
	check(call("GET", createdPath+"/members", "", "", workspaceAdminCookie), 200)
	check(call("GET", createdPath+"/agent-tokens", "", "", workspaceAdminCookie), 403)
	check(call("GET", createdPath+"/agent-tokens", "", "", site), 403)
	check(call("GET", createdPath+"/agent-tool-audit", "", "", site), 403)
	check(call("GET", createdPath+"/agent-tokens", "", "", super), 200)
	check(call("GET", createdPath+"/conversation", "", "", qa), 403)
	check(call("PATCH", createdPath+"/author-engine", `{"revision":1,"authorEngine":"external"}`, "", qa), 403)
	check(call("PUT", createdPath+"/members/dev-qa", `{"role":"workspace_admin"}`, "", workspaceAdminCookie), 403)
	check(call("PUT", createdPath+"/members/dev-workspace-admin", `{"role":"none"}`, "", workspaceAdminCookie), 403)
	check(call("PUT", createdPath+"/members/dev-workspace-admin", `{"role":"none"}`, "", site), 200)
	check(call("GET", createdPath+"/conversation", "", "", workspaceAdminCookie), 404)
	check(call("PUT", createdPath+"/members/dev-workspace-admin", `{"role":"workspace_admin"}`, "", site), 200)
	check(call("POST", createdPath+"/tests", `{"name":"QA fixture"}`, "", qa), 201)
	check(call("GET", seedTest+"?workspaceId="+workspace.ID, "", "", qa), 404)

	setupRun, err := p.CreateWorkspaceAuthor(ctx, workspace.ID, "設定測試網站", workspace.Revision, 0)
	if err != nil {
		t.Fatal(err)
	}
	settingsRunPath := "/api/runs/" + setupRun.Run.ID
	check(call("GET", settingsRunPath, "", "", workspaceAdminCookie), 200)
	check(call("GET", settingsRunPath, "", "", qa), 403)
	check(call("HEAD", settingsRunPath+"/artifacts/report.html", "", "", qa), 403)
	check(call("GET", settingsRunPath+"/live", "", "", qa), 403)

	queued := check(call("POST", seedTest+"/runs", "", "", qa), 202)
	var run Run
	if err := json.Unmarshal(queued.Body.Bytes(), &run); err != nil || run.Status != "queued" {
		t.Fatalf("QA could not queue a test: %s", queued.Body)
	}
	runPath := "/api/runs/" + run.ID
	check(call("GET", runPath+"/artifacts", "", "", qa), 200)
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() { finished <- call("GET", runPath+"/live", "", "", qa) }()
	select {
	case <-viewing:
	case <-time.After(3 * time.Second):
		t.Fatal("authorized QA never reached the viewer")
	}
	check(call("PUT", seedWorkspace+"/members/dev-qa", `{"role":"none"}`, "", workspaceAdminCookie), 200)
	select {
	case response := <-finished:
		check(response, 204)
	case <-time.After(3 * time.Second):
		t.Fatal("revoked QA viewer is still connected")
	}
	check(call("GET", runPath+"/live", "", "", qa), 404)
	check(call("GET", seedTest+"?workspaceId="+workspace.ID, "", "", qa), 404)
	check(call("GET", runPath+"?workspaceId="+workspace.ID, "", "", qa), 404)
	check(call("GET", runPath+"/artifacts", "", "", qa), 404)
	check(call("HEAD", runPath+"/artifacts/report.html", "", "", qa), 404)
	check(call("POST", runPath+"/cancel", "", "", qa), 404)
	if after, err := p.Run(ctx, run.ID); err != nil || after.Status != "queued" {
		t.Fatal("membership revocation changed an existing Run", err)
	}
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	after := check(call("GET", "/api/workspaces", "", "", qa), 200)
	if err := json.Unmarshal(after.Body.Bytes(), &saved); err != nil || len(saved.Items) != 1 || saved.Items[0].ID != workspace.ID {
		t.Fatalf("revoked membership was restored or another Workspace disappeared: %s", after.Body)
	}

	check(call("PATCH", "/api/users/dev-admin/role", `{"role":"none"}`, "", site), 403)
	check(call("PATCH", "/api/users/dev-qa/role", `{"role":"superadmin"}`, "", site), 403)
	check(call("PATCH", "/api/users/dev-admin/role", `{"role":"none"}`, "", super), 409)
	check(call("PATCH", "/api/users/dev-qa/role", `{"role":"site_admin"}`, "", site), 200)
	check(call("GET", "/api/users", "", "", qa), 200)
	check(call("GET", seedTest, "", "", qa), 200)
	check(call("PATCH", "/api/users/dev-qa/role", `{"role":"none"}`, "", site), 200)
	check(call("GET", seedTest, "", "", qa), 404)
	check(call("PATCH", "/api/users/dev-site-admin/role", `{"role":"superadmin"}`, "", super), 200)
	done := make(chan int, 2)
	go func() { done <- call("PATCH", "/api/users/dev-admin/role", `{"role":"none"}`, "", site).Code }()
	go func() { done <- call("PATCH", "/api/users/dev-site-admin/role", `{"role":"none"}`, "", super).Code }()
	first, second := <-done, <-done
	if first != 200 {
		first, second = second, first
	}
	if first != 200 || second != 403 && second != 409 {
		t.Fatalf("expected exactly one concurrent demotion, got %d and %d", first, second)
	}
	var count int
	if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM platform_users WHERE site_role='superadmin'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("last Super Admin invariant failed", count, err)
	}
}
