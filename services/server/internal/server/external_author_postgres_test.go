//go:build integration

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestM11ExternalAuthorClaimAndImmutableSnapshot(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "external author")
	if err != nil {
		t.Fatal(err)
	}
	w, err = p.SetAuthorEngine(ctx, w.ID, w.Revision, "external")
	if err != nil || w.AuthorEngine != "external" || w.Revision != 2 {
		t.Fatalf("set engine: %+v %v", w, err)
	}
	if _, err = p.SetAuthorEngine(ctx, w.ID, 1, "builtin"); err == nil {
		t.Fatal("stale engine revision accepted")
	}
	test, err := p.CreateTest(ctx, w.ID, "external test", "")
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := p.CreateAuthor(ctx, test.ID, session.ID, "寫一個測試", session.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Run.AuthorEngine != "external" {
		t.Fatalf("author engine was not snapshotted: %q", sub.Run.AuthorEngine)
	}
	if err = p.RegisterManager(ctx, "m11-external-manager", 1); err != nil {
		t.Fatal(err)
	}
	managerTask, err := p.Claim(ctx, "m11-external-manager", 1)
	if err != nil || managerTask != nil {
		t.Fatalf("Manager stole external Run: %+v %v", managerTask, err)
	}
	token, _, err := p.CreateAgentToken(ctx, w.ID, "external")
	if err != nil {
		t.Fatal(err)
	}
	task, err := p.ClaimExternalAuthor(ctx, token, NewID())
	if err != nil || task == nil || task.RunID != sub.Run.ID || task.ContextBundle.Author.SkillID != "test-author" {
		t.Fatalf("external claim: %+v %v", task, err)
	}
	for _, name := range task.ContextBundle.Author.AllowedTools {
		if name == "update_draft" || name == "request_validation" {
			t.Fatalf("unwired tool disclosed: %s", name)
		}
	}
	other, _, err := p.CreateAgentToken(ctx, w.ID, "other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.HeartbeatExternalAuthor(ctx, other, task.RunID, task.AttemptID, task.LeaseID); err == nil {
		t.Fatal("other token heartbeat accepted")
	}
	if _, err = p.HeartbeatExternalAuthor(ctx, token, task.RunID, task.AttemptID, task.LeaseID); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE external_author_claims SET expires_at=now()-interval '1 second' WHERE run_id=$1`, task.RunID); err != nil {
		t.Fatal(err)
	}
	if err = p.ExpireExternalClaims(ctx); err != nil {
		t.Fatal(err)
	}
	run, err := p.Run(ctx, task.RunID)
	if err != nil || run.Status != "timed_out" {
		t.Fatalf("expired run: %+v %v", run, err)
	}
	if _, err = p.HeartbeatExternalAuthor(ctx, token, task.RunID, task.AttemptID, task.LeaseID); err == nil {
		t.Fatal("expired heartbeat accepted")
	}
	for _, column := range []string{"editing_session_id", "workspace_id", "workspace_context", "author_engine"} {
		var query string
		switch column {
		case "editing_session_id":
			query = `UPDATE runs SET editing_session_id=NULL WHERE id=$1`
		case "workspace_id":
			query = `UPDATE runs SET workspace_id=$2 WHERE id=$1`
		case "workspace_context":
			query = `UPDATE runs SET workspace_context='{}'::jsonb WHERE id=$1`
		case "author_engine":
			query = `UPDATE runs SET author_engine='builtin' WHERE id=$1`
		}
		var e error
		if column == "workspace_id" {
			otherWorkspace, ce := p.CreateWorkspace(ctx, "other")
			if ce != nil {
				t.Fatal(ce)
			}
			_, e = p.DB.ExecContext(ctx, query, task.RunID, otherWorkspace.ID)
		} else {
			_, e = p.DB.ExecContext(ctx, query, task.RunID)
		}
		if e == nil || !strings.Contains(e.Error(), "run snapshot cannot be changed") {
			t.Fatalf("immutable %s was not guarded: %v", column, e)
		}
	}
}

func TestM11ExternalBrowserBusyRetrySameCallIDMCP(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "external browser")
	if err != nil {
		t.Fatal(err)
	}
	config := WorkspaceConfig{Name: "external browser", Targets: []WorkspaceOrigin{{Name: "synthetic", Origin: "https://m11.invalid"}}, Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{}, TimeoutMS: 15000}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,canonical_config=$2 WHERE id=$1`, w.ID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	w, err = p.SetAuthorEngine(ctx, w.ID, w.Revision, "external")
	if err != nil {
		t.Fatal(err)
	}
	test, err := p.CreateTest(ctx, w.ID, "browser task", "")
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.CreateAuthor(ctx, test.ID, session.ID, "探索頁面", session.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	_, secret, err := p.CreateAgentToken(ctx, w.ID, "browser agent")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	handler := NewAPI(p, nil, engine, NewID(), log).WithAdminAccess(NewID(), "https://whippet.example").Handler(nil)
	post := func(name string, args any) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
		r := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("Authorization", "Bearer "+secret)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		return rec
	}
	claimed := post("task_claim", map[string]any{"requestId": NewID()})
	var claim struct {
		Result struct {
			Structured struct {
				Task ExternalTask `json:"task"`
			} `json:"structuredContent"`
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if claimed.Code != 200 || json.Unmarshal(claimed.Body.Bytes(), &claim) != nil || claim.Result.IsError || !ValidID(claim.Result.Structured.Task.LeaseID) {
		t.Fatal("MCP task_claim failed")
	}
	task := claim.Result.Structured.Task
	allowed := false
	for _, name := range task.ContextBundle.Author.AllowedTools {
		if name == "browser_snapshot" {
			allowed = true
		}
	}
	if !allowed {
		t.Fatal("confirmed scope omitted browser_snapshot")
	}
	callID := NewID()
	args := map[string]any{"runId": task.RunID, "attemptId": task.AttemptID, "leaseId": task.LeaseID, "callId": callID, "name": "browser_snapshot", "arguments": map[string]any{}}
	if first := post("task_tool_call", args); first.Code != 200 || !bytes.Contains(first.Body.Bytes(), []byte(`"error":"busy"`)) {
		t.Fatal("missing Manager did not return retryable busy")
	}
	var state string
	if err = p.DB.QueryRowContext(ctx, `SELECT state FROM external_author_tool_calls WHERE run_id=$1 AND call_id=$2`, task.RunID, callID).Scan(&state); err != nil || state != "pending" {
		t.Fatalf("undispatched busy was not pending: %s %v", state, err)
	}
	peer := &browserTestPeer{messages: make(chan Envelope, 16)}
	manager, err := engine.Attach(ctx, "m11-task-browser", 1, peer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { engine.Detach(manager) })
	if err = engine.Handle(ctx, manager, NewEnvelope("heartbeat", "m11-task-browser", "", "", map[string]any{"active": []any{}, "sessions": []any{}})); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer, "heartbeat_ack")
	retried := make(chan *httptest.ResponseRecorder, 1)
	go func() { retried <- post("task_tool_call", args) }()
	opened := nextBrowserMessage(t, peer, "session.open")
	var lease struct {
		SessionID string `json:"sessionId"`
		LeaseID   string `json:"leaseId"`
	}
	if json.Unmarshal(opened.Payload, &lease) != nil || !ValidID(lease.SessionID) {
		t.Fatal("task browser open did not reach Manager")
	}
	if err = engine.Handle(ctx, manager, NewEnvelope("session.ready", "m11-task-browser", "", "", lease)); err != nil {
		t.Fatal(err)
	}
	called := nextBrowserMessage(t, peer, "session.call")
	var call struct {
		CallID string `json:"callId"`
		Name   string `json:"name"`
	}
	if json.Unmarshal(called.Payload, &call) != nil || call.CallID != callID || call.Name != "browser_snapshot" {
		t.Fatal("retry dispatched a different call")
	}
	if err = engine.Handle(ctx, manager, NewEnvelope("session.reply", "m11-task-browser", "", "", map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID, "callId": callID, "result": map[string]any{"snapshot": "synthetic"}})); err != nil {
		t.Fatal(err)
	}
	if result := <-retried; result.Code != 200 || !bytes.Contains(result.Body.Bytes(), []byte("synthetic")) {
		t.Fatal("same callId did not recover after Manager ready")
	}
	if replay := post("task_tool_call", args); replay.Code != 200 || !bytes.Contains(replay.Body.Bytes(), []byte("synthetic")) {
		t.Fatal("completed call did not replay result")
	}
	changed := map[string]any{"runId": task.RunID, "attemptId": task.AttemptID, "leaseId": task.LeaseID, "callId": callID, "name": "browser_navigate", "arguments": map[string]any{"url": "https://m11.invalid"}}
	if mismatch := post("task_tool_call", changed); mismatch.Code != 200 || !bytes.Contains(mismatch.Body.Bytes(), []byte(`"isError":true`)) {
		t.Fatal("same callId with different body was accepted")
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE external_author_tool_calls SET state='unknown',result=NULL WHERE run_id=$1 AND call_id=$2`, task.RunID, callID); err != nil {
		t.Fatal(err)
	}
	if unknown := post("task_tool_call", args); unknown.Code != 200 || !bytes.Contains(unknown.Body.Bytes(), []byte(`"error":"unknown_result"`)) {
		t.Fatal("unknown result replay was not tombstoned")
	}
	select {
	case m := <-peer.messages:
		t.Fatalf("unknown call resent %s", m.Type)
	default:
	}
}
