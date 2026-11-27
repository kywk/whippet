//go:build integration

package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWLA1WorkspaceProposalHTTP(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	if err := p.RegisterManager(ctx, "m7-test", 1); err != nil {
		t.Fatal(err)
	}
	h := m7DBHarness{t, p, ctx, files}
	w, err := p.CreateWorkspace(ctx, "說明中心")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	defer engine.Close()
	handler := NewAPI(p, files, engine, "fixture-manager", log).WithAdminAccess(fixtureAdminKey, fixtureOrigin).Handler(nil)
	path := "/api/workspaces/" + w.ID
	call := func(method, path, body string, cookie *http.Cookie, want int) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(body))
		request.Header.Set("Origin", fixtureOrigin)
		if cookie == nil {
			request.Header.Set("X-Whippet-Admin-Token", fixtureAdminKey)
		} else {
			request.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, response.Code, want, response.Body)
		}
		return response
	}
	login := func(user string) *http.Cookie {
		return call("POST", "/api/dev-login", jsonText(map[string]string{"userId": user}), nil, 200).Result().Cookies()[0]
	}
	admin, qa := login(developmentWorkspaceAdmin), login(developmentQA)
	decode := func(response *httptest.ResponseRecorder, dst any) {
		t.Helper()
		if err := json.Unmarshal(response.Body.Bytes(), dst); err != nil {
			t.Fatal(err)
		}
	}
	read := func() Workspace {
		var workspace Workspace
		decode(call("GET", path, "", admin, 200), &workspace)
		return workspace
	}
	proposalPath := func(proposal *WorkspaceProposal) string { return path + "/proposals/" + proposal.ID }
	interview := func(config WorkspaceConfig, previous *WorkspaceProposal) *WorkspaceProposal {
		t.Helper()
		var conversation WorkspaceConversation
		decode(call("GET", path+"/conversation", "", admin, 200), &conversation)
		var submission AuthorSubmission
		decode(call("POST", path+"/messages", jsonText(map[string]any{
			"content": "設定這次要測試的站台", "revision": read().Revision, "contextRevision": conversation.ContextRevision,
		}), admin, 202), &submission)
		a := h.claim(submission.Run.ID)
		if previous == nil {
			if !strings.Contains(jsonText(a.Author), `"workspaceProposal":null`) || hasBrowserTools(a.Author) {
				t.Fatal("first interview had prior content or browser tools")
			}
		} else {
			expected := WorkspaceInterviewProposal{Content: previous.Content, SiteReadiness: previous.SiteReadiness}
			if jsonText(a.Author.WorkspaceProposal) != jsonText(expected) {
				t.Fatal("interview did not freeze the prior proposal")
			}
		}
		h.upload(a, "author.json", jsonText(workspaceAuthorOutput{Message: "候選設定", Proposal: &config}))
		h.complete(a, "succeeded")
		h.release()
		proposal := read().CurrentProposal
		if proposal == nil || proposal.SourceRunID != a.ID || proposal.Status != "pending" {
			t.Fatalf("interview failed to persist proposal: %+v", proposal)
		}
		return proposal
	}
	action := func(proposal *WorkspaceProposal, name string, cookie *http.Cookie, want int) *httptest.ResponseRecorder {
		return call("POST", proposalPath(proposal)+"/"+name,
			jsonText(map[string]any{"baseRevision": proposal.BaseRevision, "confirmed": true}), cookie, want)
	}
	assertBlocked := func(proposal *WorkspaceProposal, reason string) {
		t.Helper()
		if response := action(proposal, "confirm", admin, 409); !strings.Contains(response.Body.String(), `"code":"workspace_setup_incomplete"`) {
			t.Fatalf("wrong conflict: %s", response.Body)
		}
		var reopened WorkspaceProposal
		decode(call("GET", proposalPath(proposal), "", admin, 200), &reopened)
		if reopened.Status != "pending" || len(reopened.SiteReadiness) != 1 || reopened.SiteReadiness[0].Ready ||
			stringValue(reopened.SiteReadiness[0].Reason) != reason || read().Settings != nil {
			t.Fatalf("incomplete proposal changed state: %+v", reopened)
		}
	}

	config := WorkspaceConfig{
		Name: w.Name, Purpose: "驗證說明文章", BackgroundSummary: "網站提供公開說明及登入入口", TimeoutMS: 60000,
		Targets: []WorkspaceOrigin{{Name: w.Name, Purpose: "查詢文章", Origin: "https://help.example"}},
	}
	unanswered := interview(config, nil)
	if unanswered.Content.Targets[0].TestScope != testScopeUnknown || unanswered.AccountCredentials == nil {
		t.Fatalf("legacy defaults were not exposed: %+v", unanswered)
	}
	assertBlocked(unanswered, "scope_choice_required")
	var scoped WorkspaceProposal
	decode(action(unanswered, "confirm-scope", admin, 200), &scoped)
	if !scoped.ScopeConfirmed {
		t.Fatal("site choice incorrectly blocked exploration approval")
	}
	assertBlocked(&scoped, "scope_choice_required")

	config.Targets[0].TestScope = testScopeBoth
	config.TestAccounts = []TestAccount{{Name: "會員", Role: "會員", Purpose: "查看訂單", Sites: []SiteLogin{{
		TargetOrigin: config.Targets[0].Origin, LoginMethod: stringPointer("sso"),
	}}}}
	loginRequired := interview(config, &scoped)
	if loginRequired.ScopeHash != scoped.ScopeHash || !loginRequired.ScopeConfirmed ||
		len(loginRequired.AccountCredentials) != 1 || !ValidID(loginRequired.AccountCredentials[0].AccountID) ||
		loginRequired.AccountCredentials[0].Configured || loginRequired.AccountCredentials[0].SecretVersion != nil ||
		stringValue(loginRequired.SiteReadiness[0].Accounts[0].Reason) != "unsupported_login_method" {
		t.Fatalf("missing account status or changed scope approval: %+v", loginRequired)
	}
	assertBlocked(loginRequired, "login_verification_required")

	config.Targets[0].TestScope, config.TestAccounts = testScopeGuest, []TestAccount{}
	guest := interview(config, loginRequired)
	action(guest, "confirm", qa, 403)
	var applied struct {
		Workspace Workspace
		Proposal  WorkspaceProposal
	}
	decode(action(guest, "confirm", admin, 200), &applied)
	site := applied.Workspace.SiteReadiness[0]
	if applied.Workspace.Revision != w.Revision+1 || applied.Workspace.Lifecycle != "active" || applied.Proposal.Status != "applied" ||
		!site.Ready || site.TestScope != testScopeGuest || site.Reason != nil || site.Accounts == nil || len(site.Accounts) != 0 ||
		applied.Workspace.Settings.TestAccounts == nil || len(applied.Workspace.Settings.TestAccounts) != 0 {
		t.Fatalf("zero-account guest proposal did not apply: %+v", applied)
	}

	config.Targets[0].Origin = "https://replacement.example"
	replacement := interview(config, &applied.Proposal)
	if replacement.ScopeConfirmed {
		t.Fatal("new target inherited approval")
	}
	action(replacement, "confirm-scope", admin, 200)
	action(replacement, "cancel", admin, 200)
	final := read()
	if final.Revision != applied.Workspace.Revision || final.AuthorizationRevision != applied.Workspace.AuthorizationRevision ||
		jsonText(final.Settings) != jsonText(applied.Workspace.Settings) {
		t.Fatal("draft scope changes invalidated the applied Workspace")
	}
}
