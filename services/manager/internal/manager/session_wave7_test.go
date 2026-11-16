package manager

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestSessionCredentialResolverBindsActiveCallAndNeverUsesRunIdentity(t *testing.T) {
	run, _, _ := credentialFixture(t)
	role := ""
	var snapshot workspaceContext
	if json.Unmarshal(run.WorkspaceContext, &snapshot) != nil {
		t.Fatal("invalid fixture")
	}
	role = snapshot.RoleRefs[0].RoleID
	sessionID, leaseID, callID, requestID := newID(), newID(), newID(), newID()
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls.Add(1)
		if req.URL.Path != "/api/manager/browser-sessions/"+sessionID+"/leases/"+leaseID+"/credentials/resolve" ||
			req.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("wrong session resolver binding")
		}
		body, _ := io.ReadAll(req.Body)
		if !exactWorkspaceObject(body, "roleId") || !bytes.Contains(body, []byte(role)) || bytes.Contains(body, []byte("secretRef")) {
			t.Error("resolver request carried extra identity")
		}
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(sessionCredentialValues{SessionID: sessionID, LeaseID: leaseID, WorkspaceID: run.WorkspaceID, RoleID: role,
			LoginOrigin: "https://example.test", Username: "fixture-user", Password: "fixture-pass"})
	}))
	defer server.Close()
	m, err := New(Config{ServerURL: server.URL, Token: "fixture-token", ManagerID: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.http = server.Client()
	r := sessionRecord{SessionID: sessionID, LeaseID: leaseID, WorkspaceID: run.WorkspaceID, DeadlineAt: time.Now().Add(time.Minute).UnixMilli(), State: "ready"}
	m.sessions[sessionID] = r
	m.sessionWorking[sessionID] = &sessionWorkingState{workspace: &snapshot, calls: map[string]*sessionCallState{callID: {roleID: role}}, active: callID, credentialSeen: map[string]bool{}}
	var output bytes.Buffer
	ctx := context.Background()
	writer := &attemptInputWriter{ctx: ctx, input: &output}
	q := sessionCredentialRequest{Kind: "credential_request", SessionID: sessionID, LeaseID: leaseID, CallID: callID, RequestID: requestID, RoleID: role}
	m.handleSessionCredential(ctx, r, q, writer)
	m.wg.Wait()
	if calls.Load() != 1 {
		t.Fatal("resolver was not called exactly once")
	}
	var reply sessionCredentialReply
	if json.Unmarshal(bytes.TrimSpace(output.Bytes()), &reply) != nil || reply.Credentials == nil || reply.Credentials.Password != "fixture-pass" || reply.CallID != callID {
		t.Fatal("credential stdin reply mismatch")
	}
	output.Reset()
	m.handleSessionCredential(ctx, r, q, writer)
	if calls.Load() != 1 || bytes.Contains(output.Bytes(), []byte("fixture-pass")) {
		t.Fatal("repeated request re-resolved or leaked credentials")
	}
}

func TestSessionCredentialLateResponseCannotReviveLease(t *testing.T) {
	run, _, _ := credentialFixture(t)
	var snapshot workspaceContext
	if json.Unmarshal(run.WorkspaceContext, &snapshot) != nil {
		t.Fatal("invalid fixture")
	}
	role := snapshot.RoleRefs[0].RoleID
	sessionID, leaseID, callID := newID(), newID(), newID()
	entered, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(sessionCredentialValues{SessionID: sessionID, LeaseID: leaseID, WorkspaceID: run.WorkspaceID, RoleID: role,
			LoginOrigin: "https://example.test", Username: "fixture-user", Password: "fixture-pass"})
	}))
	defer server.Close()
	m, err := New(Config{ServerURL: server.URL, Token: "fixture-token", ManagerID: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.http = server.Client()
	r := sessionRecord{SessionID: sessionID, LeaseID: leaseID, WorkspaceID: run.WorkspaceID, DeadlineAt: time.Now().Add(time.Minute).UnixMilli(), State: "ready"}
	m.sessions[sessionID] = r
	m.sessionWorking[sessionID] = &sessionWorkingState{workspace: &snapshot, calls: map[string]*sessionCallState{callID: {roleID: role}}, active: callID, credentialSeen: map[string]bool{}}
	var output bytes.Buffer
	ctx := context.Background()
	m.handleSessionCredential(ctx, r, sessionCredentialRequest{Kind: "credential_request", SessionID: sessionID, LeaseID: leaseID, CallID: callID, RequestID: newID(), RoleID: role}, &attemptInputWriter{ctx: ctx, input: &output})
	<-entered
	m.mu.Lock()
	closing := m.sessions[sessionID]
	closing.State = "closing"
	m.sessions[sessionID] = closing
	m.mu.Unlock()
	close(release)
	m.wg.Wait()
	if output.Len() != 0 {
		t.Fatal("late credential response reached closing lease")
	}
}

func TestManagerServerCAFileTrustsOnlyConfiguredCA(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			websocket.Handler(func(conn *websocket.Conn) { conn.Close() }).ServeHTTP(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "server-ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	config, err := serverTLSConfig(Config{ServerURL: server.URL, ServerCAFile: ca})
	if err != nil || config == nil {
		t.Fatal("configured CA rejected", err)
	}
	resp, err := newHTTPClientWithTLS(config).Get(server.URL)
	if err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatal("configured CA did not verify TLS", err)
	}
	resp.Body.Close()
	wsURL := "wss" + strings.TrimPrefix(server.URL, "https") + "/ws"
	wsConfig, err := websocket.NewConfig(wsURL, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	wsConfig.TlsConfig = config
	conn, err := wsConfig.DialContext(context.Background())
	if err != nil {
		t.Fatal("configured CA did not verify WSS", err)
	}
	conn.Close()
	wrong := filepath.Join(t.TempDir(), "wrong-ca.pem")
	if err := os.WriteFile(wrong, []byte("not a CA"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := serverTLSConfig(Config{ServerURL: server.URL, ServerCAFile: wrong}); err == nil {
		t.Fatal("invalid CA accepted")
	}
	roots := x509.NewCertPool()
	if _, err := newHTTPClientWithTLS(&tls.Config{RootCAs: roots}).Get(server.URL); err == nil {
		t.Fatal("untrusted CA accepted")
	}
	wsConfig.TlsConfig = &tls.Config{RootCAs: roots}
	if conn, err := wsConfig.DialContext(context.Background()); err == nil {
		conn.Close()
		t.Fatal("untrusted CA accepted by WSS")
	}
}

func TestSessionLiveControlMatchesLeaseAndViewer(t *testing.T) {
	sessionID, leaseID, viewerID := newID(), newID(), newID()
	var stopped atomic.Int32
	m := &Manager{cfg: Config{ManagerID: "fixture"}, sessions: map[string]sessionRecord{sessionID: {SessionID: sessionID, LeaseID: leaseID, State: "closing"}}, live: map[string]*liveSession{
		sessionLiveKey(sessionID): {viewerID: viewerID, cancel: func() { stopped.Add(1) }},
	}}
	if err := m.startSessionLive(context.Background(), message("fixture", "session.live.start", "", "", sessionLiveStart{SessionID: sessionID, LeaseID: leaseID, ViewerID: viewerID, ICE: json.RawMessage(`[]`)})); err == nil {
		t.Fatal("closing lease started LiveView")
	}
	if err := m.stopSessionLive(message("fixture", "session.live.stop", "", "", sessionLiveStart{SessionID: sessionID, LeaseID: newID(), ViewerID: viewerID})); err == nil {
		t.Fatal("wrong lease stopped viewer")
	}
	if stopped.Load() != 0 {
		t.Fatal("wrong lease changed viewer")
	}
	if err := m.stopSessionLive(message("fixture", "session.live.stop", "", "", sessionLiveStart{SessionID: sessionID, LeaseID: leaseID, ViewerID: newID()})); err != nil {
		t.Fatal(err)
	}
	if stopped.Load() != 0 {
		t.Fatal("old viewer stopped current viewer")
	}
	if err := m.stopSessionLive(message("fixture", "session.live.stop", "", "", sessionLiveStart{SessionID: sessionID, LeaseID: leaseID, ViewerID: viewerID})); err != nil {
		t.Fatal(err)
	}
	if stopped.Load() != 1 {
		t.Fatal("current viewer not stopped")
	}
}

func TestSessionLiveStartSendsFirstJPEGThroughSessionMediaPath(t *testing.T) {
	sessionID, leaseID, workspaceID, viewerID := newID(), newID(), newID(), newID()
	firstFrame := make(chan struct{}, 1)
	server := httptest.NewUnstartedServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		request := conn.Request()
		if request.URL.Path != "/api/manager/browser-sessions/"+sessionID+"/leases/"+leaseID+"/live" ||
			request.URL.Query().Get("viewerId") != viewerID || request.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("session media URL or authorization mismatch")
			return
		}
		for {
			var data []byte
			if websocket.Message.Receive(conn, &data) != nil {
				return
			}
			if len(data) >= 4 && data[0] == 0xff && data[1] == 0xd8 {
				firstFrame <- struct{}{}
				return
			}
			var wire liveWire
			if json.Unmarshal(data, &wire) == nil && wire.Type == "ping" {
				_ = websocket.JSON.Send(conn, liveWire{Type: "pong"})
				_ = websocket.JSON.Send(conn, liveWire{Type: "mode", Mode: "jpeg"})
			}
		}
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "server-ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	m, err := New(Config{ServerURL: server.URL, ServerCAFile: ca, Token: "fixture-token", ManagerID: "fixture", WorkDir: work, MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.sessions[sessionID] = sessionRecord{SessionID: sessionID, LeaseID: leaseID, WorkspaceID: workspaceID, DeadlineAt: time.Now().Add(time.Minute).UnixMilli(), State: "ready"}
	liveDir := filepath.Join(work, "runs", "session-"+sessionID, "live")
	if err := os.MkdirAll(liveDir, 0700); err != nil {
		t.Fatal(err)
	}
	state, _ := json.Marshal(liveState{ViewerID: viewerID, State: "streaming", Transport: "jpeg"})
	if err := os.WriteFile(filepath.Join(liveDir, "state.json"), state, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(liveDir, viewerID+".jpg"), []byte{0xff, 0xd8, 0xff, 0xd9}, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	command := message("fixture", "session.live.start", "", "", sessionLiveStart{SessionID: sessionID, LeaseID: leaseID, ViewerID: viewerID, ICE: json.RawMessage(`[]`)})
	if err := m.startSessionLive(ctx, command); err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstFrame:
	case <-ctx.Done():
		t.Fatal("session LiveView did not deliver a first JPEG frame")
	}
	m.wg.Wait()
	diagnosticBytes, err := os.ReadFile(filepath.Join(work, "diagnostics", sessionID+".json"))
	if err != nil {
		t.Fatal("session Live diagnostic missing")
	}
	var diagnostic sessionLiveDiagnostic
	if json.Unmarshal(diagnosticBytes, &diagnostic) != nil {
		t.Fatal("invalid session Live diagnostic")
	}
	stages := map[string]bool{}
	for _, event := range diagnostic.Events {
		stages[event.Stage] = true
	}
	for _, stage := range []string{"command_received", "media_connecting", "media_connected", "control_written", "frame_forwarded"} {
		if !stages[stage] {
			t.Fatal("missing fixed session Live stage", stage)
		}
	}
}

func TestSessionLiveDiagnosticKeepsOnlyFixedEnumsOnMediaFailure(t *testing.T) {
	sessionID, leaseID, workspaceID, viewerID := newID(), newID(), newID(), newID()
	work := t.TempDir()
	m, err := New(Config{ServerURL: "https://127.0.0.1:1", Token: "private-marker", ManagerID: "fixture", WorkDir: work, MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.sessions[sessionID] = sessionRecord{SessionID: sessionID, LeaseID: leaseID, WorkspaceID: workspaceID, DeadlineAt: time.Now().Add(time.Minute).UnixMilli(), State: "ready"}
	command := message("fixture", "session.live.start", "", "", sessionLiveStart{SessionID: sessionID, LeaseID: leaseID, ViewerID: viewerID, ICE: json.RawMessage(`[]`)})
	if err := m.startSessionLive(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	m.wg.Wait()
	path := filepath.Join(work, "diagnostics", sessionID+".json")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("diagnostic permissions invalid")
	}
	dir, err := os.Stat(filepath.Dir(path))
	if err != nil || dir.Mode().Perm() != 0700 {
		t.Fatal("diagnostic directory permissions invalid")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("diagnostic unavailable")
	}
	if bytes.Contains(raw, []byte("private-marker")) || bytes.Contains(raw, []byte("127.0.0.1")) || bytes.Contains(raw, []byte("connection refused")) || bytes.Contains(raw, []byte("https:")) {
		t.Fatal("diagnostic included raw transport data")
	}
	var shape map[string]json.RawMessage
	if json.Unmarshal(raw, &shape) != nil || len(shape) != 4 {
		t.Fatal("diagnostic included unexpected fields")
	}
	for _, field := range []string{"sessionId", "leaseId", "viewerId", "events"} {
		if _, ok := shape[field]; !ok {
			t.Fatal("diagnostic missing fixed field")
		}
	}
	var diagnostic sessionLiveDiagnostic
	if json.Unmarshal(raw, &diagnostic) != nil || diagnostic.SessionID != sessionID || diagnostic.LeaseID != leaseID || diagnostic.ViewerID != viewerID {
		t.Fatal("diagnostic identity mismatch")
	}
	if len(diagnostic.Events) != 3 || diagnostic.Events[0].Stage != "command_received" || diagnostic.Events[1].Stage != "media_connecting" ||
		diagnostic.Events[2].Stage != "media_failed" || diagnostic.Events[2].Error != "media_connect_failed" {
		t.Fatal("diagnostic stages incorrect")
	}
	for _, event := range diagnostic.Events {
		if !sessionLiveStages[event.Stage] || !sessionLiveErrors[event.Error] || event.At.IsZero() {
			t.Fatal("diagnostic event not bounded")
		}
	}
}
