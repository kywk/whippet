package manager

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// This file is added to the Manager package only through the QA overlay.
type w3EvenRuntime struct {
	mu       sync.Mutex
	finish   chan struct{}
	reclaim  chan struct{}
	started  chan struct{}
	removing chan struct{}
	executes int
	removes  int
}

func (f *w3EvenRuntime) Execute(ctx context.Context, _ record, _ string, emit func(string, string)) execution {
	f.mu.Lock()
	f.executes++
	f.mu.Unlock()
	emit("started", "")
	close(f.started)
	select {
	case <-f.finish:
		return execution{ExitCode: 1}
	case <-ctx.Done():
		return execution{ExitCode: 1}
	}
}

func (f *w3EvenRuntime) Remove(ctx context.Context, _ record) error {
	f.mu.Lock()
	f.removes++
	f.mu.Unlock()
	select {
	case f.removing <- struct{}{}:
	default:
	}
	select {
	case <-f.reclaim:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func w3EvenAwait(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(8 * time.Second):
		t.Fatal("TIMEOUT")
	}
}

func w3EvenTransportSnapshotOK(root string) bool {
	dir := filepath.Join(root, "diagnostics")
	dirInfo, err := os.Lstat(dir)
	if err != nil || !dirInfo.IsDir() || dirInfo.Mode().Perm() != 0700 {
		return false
	}
	path := filepath.Join(dir, "manager-transport.json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 4096 {
		return false
	}
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 4096 {
		return false
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || len(value) != 7 || value["schemaVersion"] != float64(1) {
		return false
	}
	for _, key := range []string{"schemaVersion", "connectionStage", "resultSendStage", "connectionAttemptCount", "resultSendCount", "replayCount", "elapsedMs"} {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	connection, ok := value["connectionStage"].(string)
	if !ok {
		return false
	}
	switch connection {
	case "DIAL_START", "DIAL_FAILED", "HELLO_SENT", "HEARTBEAT_SENT", "REPLAY_START", "READ_LOOP", "DISCONNECTED", "UNOBSERVED":
	default:
		return false
	}
	send, ok := value["resultSendStage"].(string)
	if !ok {
		return false
	}
	switch send {
	case "NOT_ATTEMPTED", "ATTEMPTED", "SENT", "FAILED", "UNOBSERVED":
	default:
		return false
	}
	for key, minimum := range map[string]float64{"connectionAttemptCount": 3, "resultSendCount": 2, "replayCount": 2, "elapsedMs": 0} {
		n, ok := value[key].(float64)
		limit := float64(1000000)
		if key == "elapsedMs" {
			limit = 2147483647
		}
		if !ok || n != float64(int(n)) || n < minimum || n > limit {
			return false
		}
	}
	return true
}

func TestM10ZW3EvenReconnectReplay(t *testing.T) {
	t.Setenv("WHIPPET_M109_DIAGNOSTICS", "1")
	dispatch := dispatchForTest()
	var mu sync.Mutex
	connections, heartbeats, results := 0, 0, 0
	var resultIDs [2]string
	firstClosed := make(chan struct{})
	firstResult := make(chan struct{})
	secondResult := make(chan struct{})
	server := httptest.NewTLSServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		mu.Lock()
		connections++
		ordinal := connections
		mu.Unlock()
		for {
			var env Envelope
			if websocket.JSON.Receive(conn, &env) != nil {
				return
			}
			switch env.Type {
			case "heartbeat":
				mu.Lock()
				heartbeats++
				mu.Unlock()
				_ = websocket.JSON.Send(conn, message("manager-test", "heartbeat_ack", "", "", struct{}{}))
				if ordinal == 1 {
					_ = websocket.JSON.Send(conn, dispatch)
				}
			case "event":
				if ordinal == 1 {
					close(firstClosed)
					return
				}
			case "result":
				mu.Lock()
				if results < len(resultIDs) {
					resultIDs[results] = env.MessageID
				}
				results++
				mu.Unlock()
				if ordinal == 2 {
					close(firstResult)
					return
				}
				if ordinal == 3 {
					close(secondResult)
					return
				}
			}
		}
	}))
	defer server.Close()
	cert := server.Certificate()
	if cert == nil {
		t.Fatal("TLS_CERT_MISSING")
	}
	if _, err := x509.ParseCertificate(cert.Raw); err != nil {
		t.Fatal("TLS_CERT_INVALID")
	}
	caFile := t.TempDir() + "/ca.pem"
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}), 0600); err != nil {
		t.Fatal("TLS_CA_WRITE_FAILED")
	}
	m, err := New(Config{ServerURL: server.URL, ServerCAFile: caFile, Token: "synthetic", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal("MANAGER_INIT_FAILED")
	}
	fake := &w3EvenRuntime{finish: make(chan struct{}), reclaim: make(chan struct{}), started: make(chan struct{}), removing: make(chan struct{}, 1)}
	m.docker = fake
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = m.Run(ctx); close(done) }()
	defer func() {
		cancel()
		select {
		case <-fake.finish:
		default:
			close(fake.finish)
		}
		select {
		case <-fake.reclaim:
		default:
			close(fake.reclaim)
		}
		w3EvenAwait(t, done)
		_ = m.Close()
	}()
	w3EvenAwait(t, fake.started)
	w3EvenAwait(t, firstClosed)
	before := journalRecord(m, dispatch.AttemptID)
	if before.ResultMessageID == "" || activeCount(t, m) != 1 {
		t.Fatal("ACCEPTANCE_STATE_INVALID")
	}
	close(fake.finish)
	w3EvenAwait(t, fake.removing)
	if r := journalRecord(m, dispatch.AttemptID); r.Reclaimed || r.Phase == "complete" || activeCount(t, m) != 1 {
		t.Fatal("EARLY_SLOT_RELEASE")
	}
	close(fake.reclaim)
	eventually(t, func() bool { return journalRecord(m, dispatch.AttemptID).Phase == "complete" })
	after := journalRecord(m, dispatch.AttemptID)
	if !after.Reclaimed || after.Result == nil || after.Result.Status != "failed" || activeCount(t, m) != 0 {
		t.Fatal("TERMINAL_STATE_INVALID")
	}
	w3EvenAwait(t, firstResult)
	w3EvenAwait(t, secondResult)
	fake.mu.Lock()
	executes, removes := fake.executes, fake.removes
	fake.mu.Unlock()
	mu.Lock()
	gotConnections, gotHeartbeats, gotResults := connections, heartbeats, results
	firstID, secondID := resultIDs[0], resultIDs[1]
	mu.Unlock()
	if gotConnections < 3 || gotHeartbeats < 3 || gotResults != 2 || executes != 1 || removes != 1 || firstID == "" || firstID != secondID || firstID != before.ResultMessageID || after.ResultMessageID != firstID {
		t.Fatal("REPLAY_INVARIANT_FAILED")
	}
	eventually(t, func() bool { return w3EvenTransportSnapshotOK(m.cfg.WorkDir) })
}
