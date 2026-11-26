package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func admFixture(t *testing.T) provisionRequest {
	t.Helper()
	raw, err := os.ReadFile("../../../../contracts/testdata/agent-runtime.json")
	var runtime runtimeSnapshot
	if err != nil || !validRuntimeSnapshot(raw) || json.Unmarshal(raw, &runtime) != nil {
		t.Fatal("invalid runtime fixture")
	}
	return provisionRequest{OperationID: newID(), AgentID: newID(), WorkspaceID: newID(), SecretVersion: 1, Runtime: runtime, DeadlineAt: time.Now().Add(20 * time.Second).UTC()}
}

type admProbeFixture struct {
	starts  atomic.Int32
	removed chan string
	release chan struct{}
}

func (f *admProbeFixture) Probe(context.Context, provisionRequest, string) probeOutcome {
	f.starts.Add(1)
	return probeOutcome{Status: "succeeded"}
}

func (f *admProbeFixture) RemoveProbe(ctx context.Context, id string) error {
	f.removed <- id
	select {
	case <-f.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestADM14WSSProvisionSharesSlotsAndReplays(t *testing.T) {
	t.Setenv("WHIPPET_M109_DIAGNOSTICS", "0")
	ctx, stop := context.WithTimeout(context.Background(), 8*time.Second)
	defer stop()
	peers := make(chan *websocket.Conn, 2)
	frames := make(chan Envelope, 20)
	server := httptest.NewTLSServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		peers <- conn
		for {
			var env Envelope
			if websocket.JSON.Receive(conn, &env) != nil {
				return
			}
			select {
			case frames <- env:
			case <-ctx.Done():
				return
			}
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	ca := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{ServerURL: server.URL, ServerCAFile: ca, ManagerID: "manager-test", Token: "fixture", WorkDir: dir, WorkerImage: "fixture", MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	req := admFixture(t)
	m.admin = &adminCapabilities{workerCapabilities: workerCapabilities{Version: 1, Engines: []string{req.Runtime.Engine}, Skills: []string{"test-author"}}, WorkerRevision: strings.Repeat("a", 64)}
	runtime := &admProbeFixture{removed: make(chan string, 2), release: make(chan struct{})}
	release := sync.OnceFunc(func() { close(runtime.release) })
	defer func() { stop(); release(); m.wg.Wait() }()
	m.provisionRuntime = runtime
	read := func(kind string) Envelope {
		t.Helper()
		for {
			select {
			case env := <-frames:
				if env.ManagerID != "manager-test" || env.ProtocolVersion != 1 {
					t.Fatal("manager identity changed")
				}
				if env.Type == kind {
					return env
				}
			case <-ctx.Done():
				t.Fatalf("missing %s frame", kind)
			}
		}
	}
	send := func(conn *websocket.Conn, kind string, value any) {
		t.Helper()
		if err := websocket.JSON.Send(conn, message(m.cfg.ManagerID, kind, "", "", value)); err != nil {
			t.Fatal(err)
		}
	}
	connect := func(nonce string) (*websocket.Conn, <-chan error) {
		t.Helper()
		done := make(chan error, 1)
		go func() { done <- m.session(ctx) }()
		var peer *websocket.Conn
		select {
		case peer = <-peers:
		case <-ctx.Done():
			t.Fatal("Manager did not connect")
		}
		var hello struct {
			Capacity int
			Admin    adminCapabilities
		}
		if json.Unmarshal(read("hello").Payload, &hello) != nil || hello.Capacity != 1 || hello.Admin.WorkerRevision != m.admin.WorkerRevision || !validWorkerCapabilities(hello.Admin.workerCapabilities) {
			t.Fatal("missing v14 Worker capability announcement")
		}
		read("heartbeat")
		send(peer, "heartbeat_ack", map[string]any{"admin": map[string]string{"connectionNonce": nonce}})
		return peer, done
	}
	first, done := connect(strings.Repeat("a", 32))
	send(first, "agent.provision", req)
	send(first, "agent.provision", req)
	var pending provisionResult
	if json.Unmarshal(read("agent.provision_result").Payload, &pending) != nil || pending.OperationID != req.OperationID || pending.Status != "succeeded" || pending.Reclaimed {
		t.Fatal("bad pending probe result")
	}
	awaitAttempt(t, runtime.removed, req.OperationID)
	var snapshot struct {
		Admin struct {
			FreeSlots          int
			ActiveProvisionIDs []string
		}
	}
	if json.Unmarshal(m.heartbeatMessage().Payload, &snapshot) != nil || snapshot.Admin.FreeSlots != 0 || len(snapshot.Admin.ActiveProvisionIDs) != 1 || snapshot.Admin.ActiveProvisionIDs[0] != req.OperationID {
		t.Fatal("unreclaimed probe not included in Manager occupancy")
	}
	if err := m.accept(ctx, dispatchForTest()); err == nil || !strings.Contains(err.Error(), "slot") {
		t.Fatal("probe failed to occupy the shared Run slot")
	}
	if err := m.openSession(ctx, sessionOpenEnvelope(newID(), newID(), newID())); err != sessionWireError("capacity_full") {
		t.Fatal("probe failed to occupy the shared browser slot")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	<-done
	release()
	m.wg.Wait()
	second, done := connect(strings.Repeat("b", 32))
	send(second, "agent.provision_cancel", map[string]string{"operationId": req.OperationID})
	for range 2 {
		var replay provisionResult
		if json.Unmarshal(read("agent.provision_result").Payload, &replay) != nil || !replay.Reclaimed || replay.OperationID != pending.OperationID || replay.Status != pending.Status || replay.Code != nil {
			t.Fatal("probe replay lost reclaimed evidence or changed its outcome")
		}
	}
	_ = second.Close()
	<-done
	if runtime.starts.Load() != 1 {
		t.Fatal("duplicate provisioning or reconnect started a second model probe")
	}
}

func TestADM14ModelKeyResolutionPinsIdentityAndGeneration(t *testing.T) {
	fixtureA, fixtureB := admFixture(t), admFixture(t)
	workspace := map[string]string{fixtureA.AgentID: fixtureA.WorkspaceID, fixtureB.AgentID: fixtureB.WorkspaceID}
	key := map[string]string{fixtureA.AgentID: "test-model-key-a", fixtureB.AgentID: "test-model-key-b"}
	nonce := strings.Repeat("a", 32)
	var responses atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if r.URL.Path != "/api/manager/agent-keys/resolve" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer fixture" ||
			r.Header.Get("X-Whippet-Manager-Session") != nonce || json.NewDecoder(r.Body).Decode(&req) != nil {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		agent, _ := req["agentId"].(string)
		if key[agent] == "" || req["secretVersion"] != float64(1) || req["purpose"] != "run" || len(req) != 5 || req["attemptId"] == nil || req["runId"] == nil {
			w.WriteHeader(http.StatusConflict)
			return
		}
		responses.Add(1)
		w.Header().Set("Cache-Control", "no-store")
		req["workspaceId"], req["apiKey"] = workspace[agent], key[agent]
		_ = json.NewEncoder(w).Encode(req)
	}))
	defer server.Close()
	ctx, stop := context.WithCancel(context.Background())
	m := &Manager{cfg: Config{ServerURL: server.URL, Token: "fixture"}, keySession: &modelKeySession{ctx: ctx, nonce: nonce}, http: server.Client()}
	resolve := func(p provisionRequest, workspaceID string) (string, error) {
		return m.resolveModelKey(context.Background(), modelKeyRequest{modelCredential: p.credential(), Purpose: "run", RunID: newID(), AttemptID: newID()}, workspaceID)
	}
	for _, fixture := range []provisionRequest{fixtureA, fixtureB} {
		got, err := resolve(fixture, fixture.WorkspaceID)
		if err != nil || got != key[fixture.AgentID] {
			t.Fatal("resolution did not return this Agent's credential")
		}
	}
	if got, err := resolve(fixtureA, fixtureB.WorkspaceID); got != "" || err != errModelKey {
		t.Fatal("cross-Workspace resolver response reached an attempt")
	}
	fixtureA.SecretVersion++
	if got, err := resolve(fixtureA, fixtureA.WorkspaceID); got != "" || err != errModelKey {
		t.Fatal("unexpected Key version accepted")
	}
	stop()
	if got, err := resolve(fixtureB, fixtureB.WorkspaceID); got != "" || err != errModelKey || responses.Load() != 3 {
		t.Fatal("expired Manager connection could still resolve a credential")
	}
}

func TestADM14ProvisionRestartAndLateDeliveryOnlyReclaim(t *testing.T) {
	cfg := Config{ServerURL: "https://fixture.invalid", ManagerID: "manager-test", WorkDir: t.TempDir(), MaxWorkers: 1}
	first, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	req := admFixture(t)
	err = first.saveProvisionLocked(provisionRecord{OperationID: req.OperationID, Request: &req})
	_ = first.Close()
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx, cancel := context.WithCancel(context.Background())
	runtime := &admProbeFixture{removed: make(chan string, 2), release: make(chan struct{})}
	release := sync.OnceFunc(func() { close(runtime.release) })
	defer func() { cancel(); release(); m.wg.Wait() }()
	m.provisionRuntime = runtime
	m.admin = &adminCapabilities{workerCapabilities: workerCapabilities{Version: 1, Engines: []string{req.Runtime.Engine}, Skills: []string{"test-author"}}}
	m.keySession = &modelKeySession{ctx: ctx, nonce: strings.Repeat("c", 32)}
	m.recoverProvisions(ctx)
	awaitAttempt(t, runtime.removed, req.OperationID)
	m.mu.Lock()
	occupied := m.occupiedSlotsLocked()
	m.mu.Unlock()
	if occupied != 1 {
		t.Fatal("restart lost the slot before Docker reconciliation")
	}
	changed := req
	changed.SecretVersion++
	if err := m.acceptProvision(ctx, ctx, message(cfg.ManagerID, "agent.provision", "", "", changed)); err != errProvision {
		t.Fatal("same operation ID accepted different content")
	}
	late := admFixture(t)
	if err := m.cancelProvision(ctx, message(cfg.ManagerID, "agent.provision_cancel", "", "", map[string]string{"operationId": late.OperationID})); err != nil {
		t.Fatal(err)
	}
	awaitAttempt(t, runtime.removed, late.OperationID)
	_ = m.acceptProvision(ctx, ctx, message(cfg.ManagerID, "agent.provision", "", "", late))
	release()
	m.wg.Wait()
	for _, id := range []string{req.OperationID, late.OperationID} {
		r := m.provisions[id].Result
		if r == nil || r.Status != "cancelled" || !r.Reclaimed {
			t.Fatal("orphan did not finish with verified reclamation")
		}
	}
	if runtime.starts.Load() != 0 || len(m.provisionSlots) != 0 {
		t.Fatal("recovery or late delivery restarted an old model probe")
	}
}

func TestADM14WorkerArgsAndKeyChannelAreAttemptScoped(t *testing.T) {
	p := admFixture(t)
	d := dockerCLI{cfg: Config{ManagerID: "test", WorkerImage: "worker"}}
	r := record{Kind: "author", ModelCredential: &modelCredential{AgentID: p.AgentID, SecretVersion: p.SecretVersion}}
	args := strings.Join(d.createArgs(r, t.TempDir()), " ")
	if !strings.HasSuffix(args, "node dist/author/main.js --managed-model-key") || strings.Contains(args, "API_KEY") {
		t.Fatal("managed author arguments include deployment credentials or miss the private mode")
	}
	r.ModelCredential = nil
	if !strings.Contains(strings.Join(d.createArgs(r, t.TempDir()), " "), "--env OPENCODE_API_KEY") {
		t.Fatal("legacy author no longer receives deployment configuration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	secret := "attempt-fixture-key"
	var requests atomic.Int32
	c := modelKeyChannel{ctx: ctx, input: writer, workspaceID: p.WorkspaceID,
		request: modelKeyRequest{modelCredential: p.credential(), Purpose: "probe", OperationID: p.OperationID},
		resolve: func(_ context.Context, req modelKeyRequest, workspace string) (string, error) {
			requests.Add(1)
			if workspace != p.WorkspaceID || req.OperationID != p.OperationID || req.modelCredential != p.credential() {
				return "", errModelKey
			}
			return secret, nil
		},
	}
	id := newID()
	frame := map[string]any{"kind": "model_key_request", "requestId": id, "agentId": newID(), "secretVersion": p.SecretVersion}
	for _, agent := range []string{newID(), p.AgentID, p.AgentID} {
		frame["agentId"] = agent
		raw, _ := json.Marshal(frame)
		if !c.handle(string(raw)) {
			t.Fatal("a private key frame entered the log path")
		}
	}
	reply := make(chan []byte, 1)
	go func() { raw := make([]byte, 4096); n, _ := reader.Read(raw); reply <- raw[:n] }()
	select {
	case raw := <-reply:
		if !bytes.Contains(raw, []byte(secret)) || !bytes.Contains(raw, []byte(id)) || requests.Load() != 1 {
			t.Fatal("wrong or repeated response on the private pipe")
		}
	case <-ctx.Done():
		t.Fatal("missing private response")
	}
}
