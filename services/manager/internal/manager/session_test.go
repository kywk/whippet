package manager

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

type fixtureSessionRuntime struct {
	starts      atomic.Int32
	removes     atomic.Int32
	sends       atomic.Int32
	ready       chan struct{}
	release     chan struct{}
	onResult    func(sessionToolResult)
	holdReplies bool
	removeErr   error
}

func (f *fixtureSessionRuntime) Start(ctx context.Context, _ sessionRecord, _ string, ready func(), result func(sessionToolResult)) error {
	f.starts.Add(1)
	f.onResult = result
	ready()
	select {
	case f.ready <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return ctx.Err()
}
func (f *fixtureSessionRuntime) Send(_ sessionRecord, call sessionToolCall) error {
	f.sends.Add(1)
	if !f.holdReplies {
		f.onResult(sessionToolResult{SessionID: call.SessionID, LeaseID: call.LeaseID, CallID: call.CallID, Result: json.RawMessage(`{"ok":true}`)})
	}
	return nil
}
func (f *fixtureSessionRuntime) Remove(ctx context.Context, _ sessionRecord) error {
	f.removes.Add(1)
	if f.removeErr != nil {
		return f.removeErr
	}
	select {
	case <-f.release:
		return nil
	case <-ctx.Done():
		return errors.New("fixture removal pending")
	}
}

func TestSessionCloseReplayOnlyConfirmsVerifiedReclaim(t *testing.T) {
	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	runtime := &fixtureSessionRuntime{ready: make(chan struct{}, 1), release: make(chan struct{})}
	close(runtime.release)
	m.sessionsRuntime = runtime
	received := make(chan Envelope, 4)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		for {
			var event Envelope
			if websocket.JSON.Receive(conn, &event) != nil {
				return
			}
			received <- event
		}
	}))
	defer server.Close()
	ws, err := websocket.NewConfig("ws"+server.URL[len("http"):], server.URL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := ws.DialContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	m.setConn(conn)
	readClosed := func(id, lease, reason string) {
		t.Helper()
		select {
		case event := <-received:
			var payload struct {
				SessionID string `json:"sessionId"`
				LeaseID   string `json:"leaseId"`
				Reason    string `json:"reason"`
				Reclaimed bool   `json:"reclaimed"`
			}
			if event.Type != "session.closed" || !exactWorkspaceObject(event.Payload, "sessionId", "leaseId", "reason", "reclaimed") || json.Unmarshal(event.Payload, &payload) != nil || payload.SessionID != id || payload.LeaseID != lease || payload.Reason != reason || !payload.Reclaimed {
				t.Fatal("close replay did not confirm the exact reclaimed lease")
			}
		case <-time.After(time.Second):
			t.Fatal("missing verified session.closed replay")
		}
	}
	id, lease := newID(), newID()
	m.mu.Lock()
	err = m.saveSessionLocked(sessionRecord{SessionID: id, LeaseID: lease, WorkspaceID: newID(), DeadlineAt: time.Now().Add(time.Minute).UnixMilli(), State: "reclaim_pending", Reason: "idle_timeout", Reclaimed: true})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.closeSession(message("manager-test", "session.close", "", "", sessionClose{id, lease})); err != nil {
		t.Fatal(err)
	}
	readClosed(id, lease, "idle_timeout")
	if runtime.removes.Load() != 0 || m.sessionSlotCount() != 0 {
		t.Fatal("reclaimed replay changed local capacity or reran cleanup")
	}
	unknownID, unknownLease := newID(), newID()
	runtime.removeErr = errors.New("synthetic inspect failure")
	if err := m.closeSession(message("manager-test", "session.close", "", "", sessionClose{unknownID, unknownLease})); err == nil {
		t.Fatal("unknown lease cleanup failure was accepted")
	}
	select {
	case event := <-received:
		t.Fatalf("unverified lease received %s", event.Type)
	case <-time.After(40 * time.Millisecond):
	}
	runtime.removeErr = nil
	if err := m.closeSession(message("manager-test", "session.close", "", "", sessionClose{unknownID, unknownLease})); err != nil {
		t.Fatal(err)
	}
	readClosed(unknownID, unknownLease, "closed")
	if runtime.removes.Load() != 2 {
		t.Fatal("unknown lease did not perform exact cleanup check on each close")
	}
	wrongLease := newID()
	if err := m.closeSession(message("manager-test", "session.close", "", "", sessionClose{id, wrongLease})); err == nil {
		t.Fatal("existing session with different lease was accepted")
	}
	if runtime.removes.Load() != 2 {
		t.Fatal("different lease touched a container")
	}
}

func sessionOpenEnvelope(id, lease, workspace string) Envelope {
	context := json.RawMessage(`{"schemaVersion":"1","workspaceId":"` + workspace + `","settingsRevision":1,"config":{"name":"fixture","purpose":"","backgroundSummary":"","targets":[{"name":"fixture","purpose":"","origin":"https://example.test"}],"dependencies":[],"excludedOrigins":[],"exclusions":"","loginRoles":[],"defaultTestUrl":"","timeoutMs":60000},"roleRefs":[]}`)
	registry, _ := loadToolRegistry()
	return message("manager-test", "session.open", "", "", sessionOpen{SessionID: id, LeaseID: lease, WorkspaceID: workspace, WorkspaceContext: context, AllowedTools: []string{"browser_click"}, ToolRegistryVersion: registry.Version, ToolRegistrySHA256: registry.SHA256, IdleTimeoutMS: 600000, MaxLifetimeMS: 1800000})
}

func TestSessionSharesCapacityAndRetainsSlotUntilReclaimed(t *testing.T) {
	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	runtime := &fixtureSessionRuntime{ready: make(chan struct{}, 1), release: make(chan struct{})}
	m.sessionsRuntime = runtime
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	open := sessionOpenEnvelope(newID(), newID(), newID())
	if err := m.openSession(ctx, open); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runtime.ready:
	case <-time.After(time.Second):
		t.Fatal("session not ready")
	}
	var heartbeat struct {
		Sessions []struct {
			SessionID string `json:"sessionId"`
			LeaseID   string `json:"leaseId"`
			State     string `json:"state"`
		} `json:"sessions"`
	}
	if json.Unmarshal(m.heartbeatMessage().Payload, &heartbeat) != nil || len(heartbeat.Sessions) != 1 || heartbeat.Sessions[0].SessionID != openSessionID(open) || heartbeat.Sessions[0].LeaseID != openLeaseID(open) || heartbeat.Sessions[0].State != "ready" {
		t.Fatal("heartbeat missing ready session lease")
	}
	if err := m.accept(ctx, message("manager-test", "dispatch", newID(), newID(), Dispatch{Kind: "run", Script: "fixture", TimeoutMS: 1000})); err == nil {
		t.Fatal("Run admitted while session owns only slot")
	}
	if err := m.openSession(ctx, open); err != nil {
		t.Fatal("same lease should be idempotent", err)
	}
	if runtime.starts.Load() != 1 {
		t.Fatal("duplicate session container")
	}
	closeMessage := message("manager-test", "session.close", "", "", sessionClose{SessionID: openSessionID(open), LeaseID: openLeaseID(open)})
	if err := m.closeSession(closeMessage); err != nil {
		t.Fatal(err)
	}
	select {
	case <-time.After(100 * time.Millisecond):
	case <-runtime.ready:
	}
	if m.sessionSlotCount() != 1 {
		t.Fatal("slot released before Docker removal")
	}
	if json.Unmarshal(m.heartbeatMessage().Payload, &heartbeat) != nil || len(heartbeat.Sessions) != 1 || heartbeat.Sessions[0].State != "reclaim_pending" {
		t.Fatal("heartbeat lost unreclaimed session")
	}
	close(runtime.release)
	deadline := time.After(time.Second)
	for m.sessionSlotCount() != 0 {
		select {
		case <-deadline:
			t.Fatal("slot not released after removal")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if json.Unmarshal(m.heartbeatMessage().Payload, &heartbeat) != nil || len(heartbeat.Sessions) != 0 {
		t.Fatal("heartbeat retained reclaimed session")
	}
}

func openSessionID(env Envelope) string {
	var p sessionOpen
	_ = json.Unmarshal(env.Payload, &p)
	return p.SessionID
}
func openLeaseID(env Envelope) string {
	var p sessionOpen
	_ = json.Unmarshal(env.Payload, &p)
	return p.LeaseID
}

func TestSessionCallDeduplicatesAcceptedBrowserEffect(t *testing.T) {
	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	runtime := &fixtureSessionRuntime{ready: make(chan struct{}, 1), release: make(chan struct{})}
	m.sessionsRuntime = runtime
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	open := sessionOpenEnvelope(newID(), newID(), newID())
	if err := m.openSession(ctx, open); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runtime.ready:
	case <-time.After(time.Second):
		t.Fatal("session not ready")
	}
	call := message("manager-test", "session.call", "", "", sessionToolCall{SessionID: openSessionID(open), LeaseID: openLeaseID(open), CallID: newID(), Name: "browser_click", Arguments: json.RawMessage(`{"selector":"button"}`)})
	if err := m.callSession(ctx, call); err != nil {
		t.Fatal(err)
	}
	if err := m.callSession(ctx, call); err != nil {
		t.Fatal(err)
	}
	if runtime.sends.Load() != 1 {
		t.Fatal("duplicate browser effect")
	}
	var changed sessionToolCall
	_ = json.Unmarshal(call.Payload, &changed)
	changed.Arguments = json.RawMessage(`{"selector":"a"}`)
	if err := m.callSession(ctx, message("manager-test", "session.call", "", "", changed)); err == nil {
		t.Fatal("same callId with changed arguments accepted")
	}
	_ = m.closeSession(message("manager-test", "session.close", "", "", sessionClose{openSessionID(open), openLeaseID(open)}))
	close(runtime.release)
	m.wg.Wait()
}

func TestIdleSessionClosesAndReclaimsBeforeCapacityReturns(t *testing.T) {
	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.sessionIdleTimeout = 25 * time.Millisecond
	runtime := &fixtureSessionRuntime{ready: make(chan struct{}, 1), release: make(chan struct{})}
	m.sessionsRuntime = runtime
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	open := sessionOpenEnvelope(newID(), newID(), newID())
	if err := m.openSession(ctx, open); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runtime.ready:
	case <-time.After(time.Second):
		t.Fatal("session not ready")
	}
	deadline := time.After(time.Second)
	for {
		m.mu.Lock()
		state := m.sessions[openSessionID(open)]
		m.mu.Unlock()
		if state.Reason == "idle_timeout" && state.State == "reclaim_pending" {
			break
		}
		select {
		case <-deadline:
			t.Fatal("idle session did not close")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if m.sessionSlotCount() != 1 {
		t.Fatal("idle slot freed before removal")
	}
	close(runtime.release)
	m.wg.Wait()
	if m.sessionSlotCount() != 0 {
		t.Fatal("idle slot not freed after removal")
	}
}

func TestSessionHardDeadlineStartsBeforeReady(t *testing.T) {
	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	runtime := &fixtureSessionRuntime{ready: make(chan struct{}, 1), release: make(chan struct{})}
	m.sessionsRuntime = runtime
	r := sessionRecord{SessionID: newID(), LeaseID: newID(), WorkspaceID: newID(), DeadlineAt: time.Now().Add(35 * time.Millisecond).UnixMilli(), State: "starting"}
	m.mu.Lock()
	err = m.saveSessionLocked(r)
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.startSession(ctx, r, t.TempDir())
	select {
	case <-runtime.ready:
	case <-time.After(time.Second):
		t.Fatal("session not ready")
	}
	close(runtime.release)
	m.wg.Wait()
	m.mu.Lock()
	final := m.sessions[r.SessionID]
	m.mu.Unlock()
	if final.Reason != "lifetime_timeout" || !final.Reclaimed {
		t.Fatalf("deadline did not reclaim session: %s %t", final.Reason, final.Reclaimed)
	}
}

func TestManagerRestartReclaimsRecordedSessionBeforeSlotRelease(t *testing.T) {
	workDir := t.TempDir()
	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: workDir, MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	r := sessionRecord{SessionID: newID(), LeaseID: newID(), WorkspaceID: newID(), DeadlineAt: time.Now().Add(time.Minute).UnixMilli(), State: "ready"}
	m.mu.Lock()
	err = m.saveSessionLocked(r)
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: workDir, MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	runtime := &fixtureSessionRuntime{ready: make(chan struct{}, 1), release: make(chan struct{})}
	restarted.sessionsRuntime = runtime
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	restarted.recoverSessions(ctx)
	if restarted.sessionSlotCount() != 1 {
		t.Fatal("restart released slot before orphan cleanup")
	}
	close(runtime.release)
	restarted.wg.Wait()
	restarted.mu.Lock()
	final := restarted.sessions[r.SessionID]
	restarted.mu.Unlock()
	if final.Reason != "manager_restart" || !final.Reclaimed || runtime.starts.Load() != 0 || runtime.removes.Load() == 0 {
		t.Fatalf("restart recovery invalid: %s %t", final.Reason, final.Reclaimed)
	}
}

func TestStalledSessionCallTimesOutAndClosesLease(t *testing.T) {
	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.sessionCallTimeoutOverride = 25 * time.Millisecond
	runtime := &fixtureSessionRuntime{ready: make(chan struct{}, 1), release: make(chan struct{}), holdReplies: true}
	m.sessionsRuntime = runtime
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	open := sessionOpenEnvelope(newID(), newID(), newID())
	if err := m.openSession(ctx, open); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runtime.ready:
	case <-time.After(time.Second):
		t.Fatal("session not ready")
	}
	call := message("manager-test", "session.call", "", "", sessionToolCall{SessionID: openSessionID(open), LeaseID: openLeaseID(open), CallID: newID(), Name: "browser_click", Arguments: json.RawMessage(`{"selector":"button"}`)})
	if err := m.callSession(ctx, call); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(time.Second)
	for {
		m.mu.Lock()
		state := m.sessions[openSessionID(open)]
		m.mu.Unlock()
		if state.Reason == "cancelled" && state.State == "reclaim_pending" {
			break
		}
		select {
		case <-deadline:
			t.Fatal("stalled call did not close lease")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if m.sessionSlotCount() != 1 {
		t.Fatal("timeout freed slot before cleanup")
	}
	close(runtime.release)
	m.wg.Wait()
}

func TestSessionOpenRejectionWireUsesFixedErrorsAndValidIdentifiers(t *testing.T) {
	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	received := make(chan Envelope, 4)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		for {
			var event Envelope
			if websocket.JSON.Receive(conn, &event) != nil {
				return
			}
			received <- event
		}
	}))
	defer server.Close()
	ws, err := websocket.NewConfig("ws"+server.URL[len("http"):], server.URL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := ws.DialContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m.setConn(conn)
	read := func() Envelope {
		t.Helper()
		select {
		case event := <-received:
			return event
		case <-time.After(time.Second):
			t.Fatal("missing session.open_rejected")
			return Envelope{}
		}
	}
	assertReject := func(event Envelope, id, lease, code string) {
		t.Helper()
		var p struct {
			SessionID string `json:"sessionId"`
			LeaseID   string `json:"leaseId"`
			Error     string `json:"error"`
		}
		if event.Type != "session.open_rejected" || !exactWorkspaceObject(event.Payload, "sessionId", "leaseId", "error") || json.Unmarshal(event.Payload, &p) != nil || p.SessionID != id || p.LeaseID != lease || p.Error != code {
			t.Fatalf("unexpected rejection wire: %s", event.Type)
		}
	}

	invalid := message("manager-test", "session.open", "", "", map[string]string{"sessionId": newID(), "leaseId": newID()})
	m.handleSessionOpen(context.Background(), invalid)
	var ids sessionClose
	_ = json.Unmarshal(invalid.Payload, &ids)
	assertReject(read(), ids.SessionID, ids.LeaseID, "invalid_request")

	badID := message("manager-test", "session.open", "", "", map[string]string{"sessionId": "bad", "leaseId": newID()})
	m.handleSessionOpen(context.Background(), badID)
	select {
	case event := <-received:
		t.Fatalf("invalid identifier received reply %s", event.Type)
	case <-time.After(40 * time.Millisecond):
	}

	occupied := sessionOpenEnvelope(newID(), newID(), newID())
	m.mu.Lock()
	m.records[newID()] = record{RunID: newID(), AttemptID: newID(), Phase: "running"}
	m.mu.Unlock()
	m.handleSessionOpen(context.Background(), occupied)
	assertReject(read(), openSessionID(occupied), openLeaseID(occupied), "capacity_full")

	conflict := sessionOpenEnvelope(newID(), newID(), newID())
	m.mu.Lock()
	m.sessions[openSessionID(conflict)] = sessionRecord{SessionID: openSessionID(conflict), LeaseID: newID(), WorkspaceID: newID(), State: "ready", DeadlineAt: time.Now().Add(time.Minute).UnixMilli()}
	m.mu.Unlock()
	m.handleSessionOpen(context.Background(), conflict)
	assertReject(read(), openSessionID(conflict), openLeaseID(conflict), "session_unavailable")
	select {
	case event := <-received:
		t.Fatalf("conflicting lease received extra frame %s", event.Type)
	case <-time.After(40 * time.Millisecond):
	}
}
