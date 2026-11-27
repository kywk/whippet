//go:build integration

package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestWLAWorkspaceLoginPostgres(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	p.Secrets, err = NewSecretVault(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{39}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	p.WorkspaceLoginEnabled, p.CredentialTLS = true, true
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	defer engine.Close()
	peer := &browserTestPeer{messages: make(chan Envelope, 20)}
	session, err := engine.Attach(ctx, "m7-test", 1, peer)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Detach(session)
	if err := engine.Handle(ctx, session, NewEnvelope("heartbeat", "m7-test", "", "", map[string]any{"active": []ActiveAttempt{}})); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer, "heartbeat_ack")
	h := m7DBHarness{t, p, ctx, files}
	handler := NewAPI(p, files, engine, "fixture-manager", log).WithAdminAccess(fixtureAdminKey, fixtureOrigin).Handler(nil)
	call := func(method, path string, value any, want int) []byte {
		t.Helper()
		request := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(jsonText(value)))
		request.Header.Set("Origin", fixtureOrigin)
		if strings.HasPrefix(path, "/api/manager/") {
			request.Header.Set("Authorization", "Bearer fixture-manager")
		} else {
			request.Header.Set("X-Whippet-Admin-Token", fixtureAdminKey)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != want {
			if strings.HasPrefix(path, "/api/manager/") {
				t.Fatalf("Manager request returned %d, want %d", response.Code, want)
			}
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, response.Code, want, response.Body)
		}
		return response.Body.Bytes()
	}
	read := func(raw []byte, dst any) {
		t.Helper()
		if err := json.Unmarshal(raw, dst); err != nil {
			t.Fatal(err)
		}
	}
	w, err := p.CreateWorkspace(ctx, "登入驗證")
	if err != nil {
		t.Fatal(err)
	}
	const orders, support = "https://orders.example", "https://support.example"
	loginSite := func(target string) SiteLogin {
		return SiteLogin{target, stringPointer("form"), stringPointer("https://auth.example/login"),
			&FormSelectors{UsernameSelector: "#user", PasswordSelector: "#password", SubmitSelector: "#login"},
			&SuccessCheck{target + "/protected", "#account"}}
	}
	config := WorkspaceConfig{
		Name: w.Name, Purpose: "檢查登入後頁面", BackgroundSummary: "兩站共用登入服務", TimeoutMS: 60000,
		Targets: []WorkspaceOrigin{{Name: "訂單", Origin: orders, TestScope: testScopeAuthenticated},
			{Name: "客服", Origin: support, TestScope: testScopeBoth}},
		Dependencies: []WorkspaceOrigin{{Name: "共用登入", Origin: "https://auth.example", Purpose: "login"}},
		TestAccounts: []TestAccount{{Name: "會員 A", Role: "會員", Sites: []SiteLogin{loginSite(orders), loginSite(support)}},
			{Name: "會員 B", Role: "會員", Sites: []SiteLogin{loginSite(orders)}}},
	}
	submission, err := p.CreateWorkspaceAuthor(ctx, w.ID, "設定測試帳號", w.Revision, 0)
	if err != nil {
		t.Fatal(err)
	}
	author := h.claim(submission.Run.ID)
	h.upload(author, "author.json", jsonText(workspaceAuthorOutput{Message: "測試帳號提案", Proposal: &config}))
	h.complete(author, "succeeded")
	h.release()
	w, err = p.Workspace(ctx, w.ID)
	if err != nil || w.CurrentProposal == nil {
		t.Fatal("missing login proposal", err)
	}
	path := "/api/workspaces/" + w.ID
	proposal := *w.CurrentProposal
	proposalPath := path + "/proposals/" + proposal.ID
	selection := map[string]any{"baseRevision": w.Revision, "confirmed": true}
	call("POST", proposalPath+"/confirm-scope", selection, 200)
	for _, account := range proposal.Content.TestAccounts {
		id := stringValue(account.AccountID)
		body := map[string]any{"baseRevision": w.Revision, "expectedSecretVersion": 0, "username": "synthetic-user", "password": "synthetic-password"}
		var status AccountCredentialStatus
		read(call("PUT", proposalPath+"/test-accounts/"+id+"/credentials", body, 200), &status)
		if !status.Configured || secretVersion(status.SecretVersion) != 1 {
			t.Fatal("draft credential version was not saved")
		}
	}
	first, second := stringValue(proposal.Content.TestAccounts[0].AccountID), stringValue(proposal.Content.TestAccounts[1].AccountID)
	queue := func(account, target, requestID string) Run {
		t.Helper()
		var response struct{ Run Run }
		read(call("POST", proposalPath+"/verify-login", workspaceLoginRequest{w.Revision, requestID, account, target}, 202), &response)
		return response.Run
	}
	dispatch := func(run Run) (Envelope, LoginBinding) {
		t.Helper()
		if err := engine.Tick(ctx); err != nil {
			t.Fatal("verification was not dispatched", err)
		}
		wire := nextBrowserMessage(t, peer, "dispatch")
		var payload struct {
			Kind              string
			TestID            *string
			Script            string
			WorkspaceContext  *WorkspaceContext
			LoginVerification *LoginVerification
		}
		read(wire.Payload, &payload)
		if wire.Type != "dispatch" || wire.RunID != run.ID || payload.Kind != workspaceLoginVerificationKind || payload.TestID != nil || payload.Script != "" ||
			payload.LoginVerification == nil || payload.WorkspaceContext.SchemaVersion != "1" || len(payload.WorkspaceContext.RoleRefs) != 0 ||
			strings.Contains(string(wire.Payload), "synthetic-password") {
			t.Fatal("invalid dedicated login verification dispatch")
		}
		return wire, payload.LoginVerification.Binding
	}
	resolve := func(wire Envelope, binding LoginBinding, target string, want int) {
		t.Helper()
		body := AccountCredentialRequest{binding.AccountID, target, binding.SecretRef, binding.SecretVersion}
		raw := call("POST", "/api/manager/runs/"+wire.RunID+"/attempts/"+wire.AttemptID+"/credentials/resolve", body, want)
		if want == 200 {
			var response AccountCredentialResolution
			read(raw, &response)
			if response.AccountID != binding.AccountID || response.TargetOrigin != target || response.Password != "synthetic-password" {
				t.Fatal("resolver returned a different binding")
			}
		}
	}
	finish := func(wire Envelope, result Result) {
		t.Helper()
		frame := NewEnvelope("result", "m7-test", wire.RunID, wire.AttemptID, result)
		if err := engine.Handle(ctx, session, frame); err != nil {
			t.Fatal(err)
		}
		if err := engine.Handle(ctx, session, frame); err != nil {
			t.Fatal("exact result replay failed", err)
		}
		h.release()
	}
	verified := func(target string) Result {
		return Result{Status: "succeeded", LoginVerification: json.RawMessage(jsonText(map[string]any{
			"observedOrigin": target, "guest": "denied", "submitted": true, "authenticated": "selector_visible",
		}))}
	}
	requestID := NewID()
	orderRun := queue(first, orders, requestID)
	if queue(first, orders, requestID).ID != orderRun.ID {
		t.Fatal("verification retry created a second Run")
	}
	call("POST", proposalPath+"/verify-login", workspaceLoginRequest{w.Revision, requestID, first, support}, 409)
	wire, binding := dispatch(orderRun)
	resolve(wire, binding, support, 409)
	resolve(wire, binding, orders, 200)
	finish(wire, verified(orders))
	if response := call("POST", proposalPath+"/confirm", selection, 409); !strings.Contains(string(response), "workspace_setup_incomplete") {
		t.Fatal("shared service incorrectly satisfied both sites")
	}
	wire, binding = dispatch(queue(first, support, NewID()))
	resolve(wire, binding, support, 200)
	finish(wire, Result{Status: "succeeded", LoginVerification: json.RawMessage(`{"submitted":true}`)})
	var pending WorkspaceProposal
	read(call("GET", proposalPath, nil, 200), &pending)
	if !pending.SiteReadiness[0].Ready || pending.SiteReadiness[1].Ready ||
		stringValue(pending.SiteReadiness[1].Accounts[0].Reason) != "invalid_evidence" {
		t.Fatal("form submission was accepted as site evidence")
	}
	wire, binding = dispatch(queue(first, support, NewID()))
	resolve(wire, binding, support, 200)
	call("POST", "/api/runs/"+wire.RunID+"/cancel", nil, 200)
	finish(wire, verified(support))
	read(call("GET", proposalPath, nil, 200), &pending)
	if pending.SiteReadiness[1].Ready || stringValue(pending.SiteReadiness[1].Accounts[0].Reason) != "cancelled" {
		t.Fatal("late success after cancellation became evidence")
	}
	for _, item := range []struct{ account, target string }{{first, support}, {second, orders}} {
		wire, binding = dispatch(queue(item.account, item.target, NewID()))
		resolve(wire, binding, item.target, 200)
		finish(wire, verified(item.target))
	}
	call("POST", proposalPath+"/confirm", selection, 200)
	w, err = p.Workspace(ctx, w.ID)
	if err != nil || !w.SiteReadiness[0].Ready || !w.SiteReadiness[1].Ready || len(w.accountBindings) != 3 {
		t.Fatal("could not apply qualifying evidence", err)
	}
	snapshot := workspaceContext(w)
	if snapshot.SchemaVersion != "2" || len(snapshot.TestAccounts) != 2 || snapshot.TestAccounts[0].Role != snapshot.TestAccounts[1].Role ||
		snapshot.TestAccounts[0].AccountID == snapshot.TestAccounts[1].AccountID || snapshotAccountBinding(snapshot, w.ID, second, support) != nil {
		t.Fatal("same-role accounts or their site grants were conflated")
	}
	var patched Workspace
	read(call("PATCH", path+"/test-accounts/"+first, testAccountPatch{w.Revision, "會員 A", "會員", "查詢既有訂單"}, 200), &patched)
	if patched.Revision != w.Revision+1 || !patched.SiteReadiness[0].Ready || !patched.SiteReadiness[1].Ready {
		t.Fatal("description update invalidated verification")
	}
	conversation, err := p.WorkspaceConversation(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	followup, err := p.CreateWorkspaceAuthor(ctx, w.ID, "輪替會員 A 的測試帳密", patched.Revision, conversation.ContextRevision)
	if err != nil {
		t.Fatal(err)
	}
	author = h.claim(followup.Run.ID)
	h.upload(author, "author.json", jsonText(workspaceAuthorOutput{Message: "保留逐站設定", Proposal: patched.Settings}))
	h.complete(author, "succeeded")
	h.release()
	w, err = p.Workspace(ctx, w.ID)
	if err != nil || w.CurrentProposal == nil || !w.CurrentProposal.SiteReadiness[1].Ready {
		t.Fatal("unchanged formal evidence did not carry into the new proposal", err)
	}
	draftPath := path + "/proposals/" + w.CurrentProposal.ID
	call("PUT", draftPath+"/test-accounts/"+first+"/credentials",
		map[string]any{"baseRevision": w.Revision, "expectedSecretVersion": 1, "username": "synthetic-user", "password": "synthetic-new"}, 200)
	read(call("GET", draftPath, nil, 200), &pending)
	var official Workspace
	read(call("GET", path, nil, 200), &official)
	if !pending.SiteReadiness[0].Ready || pending.SiteReadiness[1].Ready || !official.SiteReadiness[1].Ready {
		t.Fatal("draft rotation affected formal or unrelated account evidence")
	}
	call("POST", draftPath+"/cancel", map[string]any{"baseRevision": w.Revision, "confirmed": true}, 200)

	test, err := p.CreateTest(ctx, w.ID, "驗證登入帳號", "")
	if err != nil {
		t.Fatal(err)
	}
	edit, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := p.SaveDraft(ctx, test.ID, edit.ID, edit.Draft.Revision, "import { test } from '@playwright/test'; test('fixture', async () => {});")
	if err != nil {
		t.Fatal(err)
	}
	validation, err := p.ValidateDraft(ctx, test.ID, edit.ID, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	assigned := h.claim(validation.ID)
	bound := snapshotAccountBinding(assigned.WorkspaceContext, w.ID, second, orders)
	if bound == nil {
		t.Fatal("normal validation Run did not pin the authorized account")
	}
	ordinary := Envelope{RunID: assigned.ID, AttemptID: assigned.AttemptID}
	resolve(ordinary, *bound, support, 409)
	resolve(ordinary, *bound, orders, 200)
	h.complete(assigned, "cancelled")
	h.release()

	verifyWorkspaceAccountMCP(t, ctx, p, engine, session, peer, handler, patched, first, second, orders, support)
}

func verifyWorkspaceAccountMCP(t *testing.T, ctx context.Context, p *Postgres, engine *Engine, session *Session, peer *browserTestPeer, handler http.Handler,
	w Workspace, first, second, orders, support string) {
	t.Helper()
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := registry.tool(browserLoginAccountTool); !ok {
		t.Log("set WHIPPET_TOOL_REGISTRY_PATH to registry 17.0 for account tool coverage")
		return
	}
	_, token, err := p.CreateAgentToken(ctx, w.ID, "synthetic WLA agent")
	if err != nil {
		t.Fatal(err)
	}
	mcp := func(name string, args, meta map[string]any) []byte {
		params := map[string]any{"name": name, "arguments": args}
		if meta != nil {
			params["_meta"] = map[string]any{"whippet": meta}
		}
		body := jsonText(map[string]any{"jsonrpc": "2.0", "method": "tools/call", "id": 1, "params": params})
		request := httptest.NewRequest("POST", fixtureOrigin+"/mcp", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Body.Bytes()
	}
	manager := func(kind string, payload any) {
		t.Helper()
		if err := engine.Handle(ctx, session, NewEnvelope(kind, session.managerID, "", "", payload)); err != nil {
			t.Fatal(err)
		}
	}
	open := func() BrowserLease {
		t.Helper()
		wire := nextBrowserMessage(t, peer, "session.open")
		var payload struct {
			SessionID    string
			LeaseID      string
			AllowedTools []string
		}
		if json.Unmarshal(wire.Payload, &payload) != nil || !slices.Contains(payload.AllowedTools, browserLoginAccountTool) {
			t.Fatal("trusted session omitted pinned login tool")
		}
		manager("session.ready", map[string]string{"sessionId": payload.SessionID, "leaseId": payload.LeaseID})
		return BrowserLease{SessionID: payload.SessionID, LeaseID: payload.LeaseID}
	}
	resolve := func(lease BrowserLease, account, target, callID string, want int) {
		t.Helper()
		body := jsonText(map[string]string{"accountId": account, "targetOrigin": target, "callId": callID})
		url := fixtureOrigin + "/api/manager/browser-sessions/" + lease.SessionID + "/leases/" + lease.LeaseID + "/credentials/resolve"
		request := httptest.NewRequest("POST", url, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer fixture-manager")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("session broker returned %d, want %d", response.Code, want)
		}
		if want == 200 {
			var value BrowserSessionAccountCredentials
			if json.Unmarshal(response.Body.Bytes(), &value) != nil || value.CallID != callID || value.AccountID != account ||
				value.TargetOrigin != target || value.Password != "synthetic-password" {
				t.Fatal("session broker returned a different binding")
			}
		}
	}
	respond := func(lease BrowserLease, account, target, callID string) {
		t.Helper()
		wire := nextBrowserMessage(t, peer, "session.call")
		var payload struct {
			SessionID string
			LeaseID   string
			CallID    string
			Name      string
		}
		if json.Unmarshal(wire.Payload, &payload) != nil || payload.Name != browserLoginAccountTool || payload.CallID != callID ||
			payload.SessionID != lease.SessionID || payload.LeaseID != lease.LeaseID {
			t.Fatal("tool call not bound to the leased session")
		}
		resolve(lease, account, "https://outside.example", callID, 409)
		resolve(lease, account, target, callID, 200)
		manager("session.reply", map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID,
			"callId": callID, "result": map[string]bool{"submitted": true}})
	}
	reply := func(raw []byte) {
		t.Helper()
		if !bytes.Contains(raw, []byte(`"submitted":true`)) || bytes.Contains(raw, []byte("synthetic-password")) {
			t.Fatal("MCP did not return only the approved submission result")
		}
	}
	opened := make(chan []byte, 1)
	go func() { opened <- mcp("browser_session_open", map[string]any{"requestId": NewID()}, nil) }()
	lease := open()
	if raw := <-opened; !bytes.Contains(raw, []byte(`"testAccounts":[`)) || !bytes.Contains(raw, []byte(`"查詢既有訂單"`)) ||
		bytes.Contains(raw, []byte("secretRef")) || bytes.Contains(raw, []byte("accountBindings")) {
		t.Fatal("interactive MCP exposed an incorrect account directory")
	}
	meta := map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID, "callId": NewID()}
	if raw := mcp(browserLoginAccountTool, map[string]any{"accountId": second, "targetOrigin": support}, meta); !bytes.Contains(raw, []byte(`"isError":true`)) {
		t.Fatal("interactive MCP accepted wrong site")
	}
	callID := NewID()
	meta["callId"] = callID
	called := make(chan []byte, 1)
	go func() {
		called <- mcp(browserLoginAccountTool, map[string]any{"accountId": first, "targetOrigin": orders}, meta)
	}()
	respond(lease, first, orders, callID)
	reply(<-called)
	args := map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID}
	if raw := mcp("browser_session_close", args, nil); bytes.Contains(raw, []byte(`"isError":true`)) {
		t.Fatal("interactive MCP could not close")
	}
	manager("session.closed", map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID, "reason": "closed", "reclaimed": true})

	enableWorkspaceLoginTestSkill(t)
	w, err = p.SetAuthorEngine(ctx, w.ID, w.Revision, "external")
	if err != nil {
		t.Fatal(err)
	}
	test, err := p.CreateTest(ctx, w.ID, "同角色帳號", "")
	if err != nil {
		t.Fatal(err)
	}
	edit, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CreateAuthor(ctx, test.ID, edit.ID, "驗證這組帳號可以看到自己的訂單", edit.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	var claim struct {
		Result struct {
			Structured struct{ Task ExternalTask } `json:"structuredContent"`
		}
	}
	raw := mcp("task_claim", map[string]any{"requestId": NewID()}, nil)
	if json.Unmarshal(raw, &claim) != nil || bytes.Contains(raw, []byte("secretRef")) || bytes.Contains(raw, []byte("accountBindings")) {
		t.Fatal("external claim did not redact private login bindings")
	}
	task := claim.Result.Structured.Task
	if task.RunID == "" || task.ContextBundle.WorkspaceContext == nil ||
		len(task.ContextBundle.WorkspaceContext.TestAccounts) != 2 || !slices.Contains(task.ContextBundle.Author.AllowedTools, browserLoginAccountTool) {
		t.Fatal("external claim did not retain its pinned account directory and tool")
	}
	callID = NewID()
	taskArgs := map[string]any{"runId": task.RunID, "attemptId": task.AttemptID, "leaseId": task.LeaseID, "callId": callID, "name": browserLoginAccountTool,
		"arguments": map[string]any{"accountId": second, "targetOrigin": support}}
	if raw := mcp("task_tool_call", taskArgs, nil); !bytes.Contains(raw, []byte(`"isError":true`)) {
		t.Fatal("MCP claim accepted wrong site")
	}
	taskArgs["arguments"] = map[string]any{"accountId": second, "targetOrigin": orders}
	go func() { called <- mcp("task_tool_call", taskArgs, nil) }()
	lease = open()
	respond(lease, second, orders, callID)
	reply(<-called)
}

func enableWorkspaceLoginTestSkill(t *testing.T) {
	t.Helper()
	root := t.TempDir()
	source := repositoryFile("runtimes", "worker", "skills")
	if path := os.Getenv("WHIPPET_SKILLS_PATH"); path != "" {
		source = path
	}
	for _, skill := range []string{"test-author", "playwright-authoring"} {
		if err := os.CopyFS(filepath.Join(root, skill), os.DirFS(filepath.Join(source, skill))); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(root, "test-author", "manifest.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var manifest SkillManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(manifest.DefaultTools, browserLoginAccountTool) {
		manifest.DefaultTools = append(manifest.DefaultTools, browserLoginAccountTool)
		if err := os.WriteFile(path, []byte(jsonText(manifest)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("WHIPPET_SKILLS_PATH", root)
}
