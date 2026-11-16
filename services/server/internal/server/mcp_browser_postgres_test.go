//go:build integration

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type browserTestPeer struct {
	mu       sync.Mutex
	messages chan Envelope
}

func (p *browserTestPeer) Send(m Envelope) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.messages <- m
	return nil
}
func (*browserTestPeer) Close() error { return nil }

func nextBrowserMessage(t *testing.T, peer *browserTestPeer, kind string) Envelope {
	t.Helper()
	select {
	case m := <-peer.messages:
		if m.Type != kind {
			t.Fatalf("manager message = %q, want %q", m.Type, kind)
		}
		return m
	case <-time.After(2 * time.Second):
		t.Fatalf("manager did not receive %s", kind)
		return Envelope{}
	}
}

func TestM11BrowserLeaseMCPWireAndPersistentDedupe(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "M11 browser")
	if err != nil {
		t.Fatal(err)
	}
	config := WorkspaceConfig{Name: "M11 browser", Targets: []WorkspaceOrigin{{Name: "synthetic", Origin: "https://m11.invalid"}}, Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{}, TimeoutMS: 15000}
	if _, err := p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,canonical_config=$2 WHERE id=$1`, w.ID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	issued, secret, err := p.CreateAgentToken(ctx, w.ID, "browser")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	peer := &browserTestPeer{messages: make(chan Envelope, 16)}
	session, err := engine.Attach(ctx, "m11-browser-test", 1, peer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { engine.Detach(session) })
	if err := engine.Handle(ctx, session, NewEnvelope("heartbeat", "m11-browser-test", "", "", map[string]any{"active": []any{}, "sessions": []any{}})); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer, "heartbeat_ack")
	api := NewAPI(p, nil, engine, NewID(), log).WithAdminAccess(NewID(), "https://whippet.example").Handler(nil)
	post := func(name string, args any, meta any) *httptest.ResponseRecorder {
		t.Helper()
		params := map[string]any{"name": name, "arguments": args}
		if meta != nil {
			params["_meta"] = map[string]any{"whippet": meta}
		}
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params})
		r := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("Authorization", "Bearer "+secret)
		rec := httptest.NewRecorder()
		api.ServeHTTP(rec, r)
		return rec
	}
	requestID := NewID()
	type response struct {
		Result struct {
			IsError    bool         `json:"isError"`
			Structured BrowserLease `json:"structuredContent"`
			Content    []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	opened := make(chan *httptest.ResponseRecorder, 1)
	go func() { opened <- post("browser_session_open", map[string]any{"requestId": requestID}, nil) }()
	openWire := nextBrowserMessage(t, peer, "session.open")
	if openWire.RunID != "" || openWire.AttemptID != "" {
		t.Fatal("browser wire used author Run identifiers")
	}
	var openPayload struct {
		SessionID   string `json:"sessionId"`
		LeaseID     string `json:"leaseId"`
		WorkspaceID string `json:"workspaceId"`
	}
	if json.Unmarshal(openWire.Payload, &openPayload) != nil || !ValidID(openPayload.SessionID) || !ValidID(openPayload.LeaseID) || openPayload.WorkspaceID != w.ID {
		t.Fatal("open did not carry an owned Workspace lease")
	}
	if err := engine.Handle(ctx, session, NewEnvelope("session.ready", "m11-browser-test", "", "", map[string]string{"sessionId": openPayload.SessionID, "leaseId": openPayload.LeaseID})); err != nil {
		t.Fatal(err)
	}
	var first response
	if result := <-opened; result.Code != http.StatusOK || json.Unmarshal(result.Body.Bytes(), &first) != nil || first.Result.IsError || first.Result.Structured.State != "ready" {
		t.Fatal("open did not return a ready lease after Manager ready")
	}
	if duplicate := post("browser_session_open", map[string]any{"requestId": requestID}, nil); duplicate.Code != http.StatusOK || !bytes.Contains(duplicate.Body.Bytes(), []byte(openPayload.SessionID)) {
		t.Fatal("same requestId did not recover the original lease")
	}
	select {
	case m := <-peer.messages:
		t.Fatalf("duplicate open sent %q", m.Type)
	default:
	}
	version := m11PublishedModule(t, p, ctx, w.ID)
	var testID string
	if err := p.DB.QueryRowContext(ctx, `SELECT test_id FROM test_versions WHERE id=$1`, version).Scan(&testID); err != nil {
		t.Fatal(err)
	}
	currentWorkspace, err := p.Workspace(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `INSERT INTO runs(id,test_id,workspace_id,version_id,script_snapshot,timeout_ms,workspace_settings,workspace_context,script_origin)
		VALUES($1,$2,$3,$4,'fixture module content',30000,$5,$6,'legacy')`, NewID(), testID, w.ID, version, settingsJSON(&currentWorkspace.WorkspaceSettings), jsonText(workspaceContext(currentWorkspace))); err != nil {
		t.Fatal(err)
	}
	if assignment, err := p.Claim(ctx, "m11-browser-test", 1); err != nil || assignment != nil {
		t.Fatalf("Run used an unreclaimed browser slot: assignment=%v err=%v", assignment != nil, err)
	}
	meta := map[string]any{"sessionId": openPayload.SessionID, "leaseId": openPayload.LeaseID, "callId": NewID()}
	if missing := post("browser_snapshot", map[string]any{}, nil); missing.Code != http.StatusOK || !bytes.Contains(missing.Body.Bytes(), []byte(`"isError":true`)) {
		t.Fatal("browser call accepted missing lease meta")
	}
	if extra := post("browser_snapshot", map[string]any{}, map[string]any{"sessionId": openPayload.SessionID, "leaseId": openPayload.LeaseID, "callId": NewID(), "workspaceId": w.ID}); extra.Code != http.StatusOK || !bytes.Contains(extra.Body.Bytes(), []byte(`"isError":true`)) {
		t.Fatal("browser call accepted an extra lease meta field")
	}
	called := make(chan *httptest.ResponseRecorder, 1)
	go func() { called <- post("browser_snapshot", map[string]any{}, meta) }()
	callWire := nextBrowserMessage(t, peer, "session.call")
	var callPayload struct {
		SessionID string `json:"sessionId"`
		LeaseID   string `json:"leaseId"`
		CallID    string `json:"callId"`
		Name      string `json:"name"`
	}
	if json.Unmarshal(callWire.Payload, &callPayload) != nil || callPayload.Name != "browser_snapshot" || callPayload.CallID != meta["callId"] {
		t.Fatal("browser call did not preserve MCP logical callId")
	}
	if pending := post("browser_snapshot", map[string]any{}, meta); pending.Code != http.StatusOK || !bytes.Contains(pending.Body.Bytes(), []byte(`"error":"busy"`)) {
		t.Fatal("same in-flight callId was not returned as fixed busy")
	}
	otherMeta := map[string]any{"sessionId": openPayload.SessionID, "leaseId": openPayload.LeaseID, "callId": NewID()}
	if other := post("browser_snapshot", map[string]any{}, otherMeta); other.Code != http.StatusOK || !bytes.Contains(other.Body.Bytes(), []byte(`"error":"busy"`)) {
		t.Fatal("different callId was not blocked while one lease call was in-flight")
	}
	select {
	case m := <-peer.messages:
		t.Fatalf("busy call sent %q", m.Type)
	default:
	}
	if err := engine.Handle(ctx, session, NewEnvelope("session.reply", "m11-browser-test", "", "", map[string]any{"sessionId": openPayload.SessionID, "leaseId": openPayload.LeaseID, "callId": callPayload.CallID, "result": map[string]any{"snapshot": "synthetic"}})); err != nil {
		t.Fatal(err)
	}
	if result := <-called; result.Code != http.StatusOK || !bytes.Contains(result.Body.Bytes(), []byte("synthetic")) {
		t.Fatal("browser reply was not returned through MCP")
	}
	if duplicate := post("browser_snapshot", map[string]any{}, meta); duplicate.Code != http.StatusOK || !bytes.Contains(duplicate.Body.Bytes(), []byte("synthetic")) {
		t.Fatal("same callId did not replay the in-memory result")
	}
	engine.mu.Lock()
	key := browserCallKey(openPayload.SessionID, callPayload.CallID)
	engine.browserCacheBytes -= len(engine.browserCalls[key].result)
	delete(engine.browserCalls, key)
	engine.mu.Unlock()
	if lost := post("browser_snapshot", map[string]any{}, meta); lost.Code != http.StatusOK || !bytes.Contains(lost.Body.Bytes(), []byte(`"error":"unknown_result"`)) {
		t.Fatal("persisted call tombstone did not return fixed unknown_result after cache loss")
	}
	select {
	case m := <-peer.messages:
		t.Fatalf("duplicate call sent %q", m.Type)
	default:
	}
	// Rate limiting has its own focused test; continue this lifecycle with a new
	// HTTP handler so this longer sequence does not consume the burst budget.
	api = NewAPI(p, nil, engine, NewID(), log).WithAdminAccess(NewID(), "https://whippet.example").Handler(nil)
	closed := post("browser_session_close", map[string]any{"sessionId": openPayload.SessionID, "leaseId": openPayload.LeaseID}, nil)
	if closed.Code != http.StatusOK || !bytes.Contains(closed.Body.Bytes(), []byte(`"closing"`)) {
		t.Fatal("close did not enter closing state")
	}
	if err := engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer, "session.close")
	if err := engine.Handle(ctx, session, NewEnvelope("session.closed", "m11-browser-test", "", "", map[string]any{"sessionId": openPayload.SessionID, "leaseId": openPayload.LeaseID, "reason": "closed", "reclaimed": true})); err != nil {
		t.Fatal(err)
	}
	status := post("browser_session_status", map[string]any{"sessionId": openPayload.SessionID, "leaseId": openPayload.LeaseID}, nil)
	if status.Code != http.StatusOK || !bytes.Contains(status.Body.Bytes(), []byte(`"reclaimed":true`)) {
		t.Fatal("confirmed cleanup did not release lease")
	}
	if assignment, err := p.Claim(ctx, "m11-browser-test", 1); err != nil || assignment == nil {
		t.Fatalf("confirmed browser cleanup did not restore Run capacity: assignment=%v err=%v", assignment != nil, err)
	}
	if retry := post("browser_session_open", map[string]any{"requestId": requestID}, nil); retry.Code != http.StatusOK || !bytes.Contains(retry.Body.Bytes(), []byte(openPayload.SessionID)) {
		t.Fatal("closed requestId reopened a new browser")
	}
	if issued.WorkspaceID != w.ID {
		t.Fatal("token workspace mismatch")
	}
	_ = context.Background()
}

func TestM11BrowserLeaseRevocationAndReconnectConverge(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "M11 revoke")
	if err != nil {
		t.Fatal(err)
	}
	config := WorkspaceConfig{Name: "M11 revoke", Targets: []WorkspaceOrigin{{Name: "synthetic", Origin: "https://m11.invalid"}}, Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{}, TimeoutMS: 15000}
	if _, err := p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,canonical_config=$2 WHERE id=$1`, w.ID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	token, _, err := p.CreateAgentToken(ctx, w.ID, "revoke")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	peer := &browserTestPeer{messages: make(chan Envelope, 16)}
	session, err := engine.Attach(ctx, "m11-reconnect", 1, peer)
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(ctx, session, NewEnvelope("heartbeat", "m11-reconnect", "", "", map[string]any{"active": []any{}, "sessions": []any{}})); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer, "heartbeat_ack")
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := p.Workspace(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	lease, existed, err := p.OpenBrowserLease(ctx, token, NewID(), "m11-reconnect", session.liveEpoch, registry, workspace)
	if err != nil || existed {
		t.Fatalf("open: existed=%v err=%v", existed, err)
	}
	if err := engine.SendBrowserOpen(lease); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer, "session.open")
	if err := engine.Handle(ctx, session, NewEnvelope("session.ready", "m11-reconnect", "", "", map[string]string{"sessionId": lease.SessionID, "leaseId": lease.LeaseID})); err != nil {
		t.Fatal(err)
	}
	if err := p.RevokeAgentToken(ctx, w.ID, token.ID); err != nil {
		t.Fatal(err)
	}
	current, err := p.BrowserLeaseBySession(ctx, lease.SessionID)
	if err != nil || current.State != "closing" || current.Reclaimed {
		t.Fatal("revocation did not atomically close the lease")
	}
	if _, err := p.ReserveBrowserCall(ctx, token, lease, NewID(), "browser_snapshot", []byte(`{}`)); err == nil {
		t.Fatal("revoked token reserved a new browser side effect")
	}
	if err := engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer, "session.close")
	if err := engine.Handle(ctx, session, NewEnvelope("session.closed", "m11-reconnect", "", "", map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID, "reason": "closed", "reclaimed": false})); err != nil {
		t.Fatal(err)
	}
	current, err = p.BrowserLeaseBySession(ctx, lease.SessionID)
	if err != nil || current.State != "reclaim_pending" || current.Reclaimed {
		t.Fatal("unconfirmed cleanup released the lease")
	}
	if err := engine.Handle(ctx, session, NewEnvelope("session.closed", "m11-reconnect", "", "", map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID, "reason": "closed", "reclaimed": true})); err != nil {
		t.Fatal(err)
	}
	current, err = p.BrowserLeaseBySession(ctx, lease.SessionID)
	if err != nil || current.State != "closed" || !current.Reclaimed {
		t.Fatal("confirmed cleanup did not close the lease")
	}

	second, _, err := p.CreateAgentToken(ctx, w.ID, "reconnect")
	if err != nil {
		t.Fatal(err)
	}
	newLease, _, err := p.OpenBrowserLease(ctx, second, NewID(), "m11-reconnect", session.liveEpoch, registry, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SendBrowserOpen(newLease); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer, "session.open")
	if err := engine.Handle(ctx, session, NewEnvelope("session.ready", "m11-reconnect", "", "", map[string]string{"sessionId": newLease.SessionID, "leaseId": newLease.LeaseID})); err != nil {
		t.Fatal(err)
	}
	if err := p.RecoverBrowserLeases(ctx); err != nil {
		t.Fatal(err)
	}
	current, err = p.BrowserLeaseBySession(ctx, newLease.SessionID)
	if err != nil || current.State != "reclaim_pending" || current.Reclaimed {
		t.Fatal("Server restart did not invalidate the old lease")
	}
	engine.Detach(session)
	current, err = p.BrowserLeaseBySession(ctx, newLease.SessionID)
	if err != nil || current.State != "reclaim_pending" || current.Reclaimed {
		t.Fatal("disconnect did not invalidate the old lease")
	}
	peer2 := &browserTestPeer{messages: make(chan Envelope, 16)}
	session2, err := engine.Attach(ctx, "m11-reconnect", 1, peer2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { engine.Detach(session2) })
	if err := engine.Handle(ctx, session2, NewEnvelope("heartbeat", "m11-reconnect", "", "", map[string]any{"active": []any{}, "sessions": []any{map[string]string{"sessionId": newLease.SessionID, "leaseId": newLease.LeaseID, "state": "ready"}}})); err != nil {
		t.Fatal(err)
	}
	nextBrowserMessage(t, peer2, "session.close")
	nextBrowserMessage(t, peer2, "heartbeat_ack")
	if err := engine.Handle(ctx, session2, NewEnvelope("session.closed", "m11-reconnect", "", "", map[string]any{"sessionId": newLease.SessionID, "leaseId": newLease.LeaseID, "reason": "closed", "reclaimed": true})); err != nil {
		t.Fatal(err)
	}
	current, err = p.BrowserLeaseBySession(ctx, newLease.SessionID)
	if err != nil || current.State != "closed" || !current.Reclaimed {
		t.Fatal("reconnected Manager cleanup did not converge")
	}
	select {
	case m := <-peer2.messages:
		if m.Type == "session.open" || m.Type == "session.call" {
			t.Fatal("reconnect replayed an uncertain operation")
		}
	default:
	}
}
