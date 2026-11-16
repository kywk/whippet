package manager

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

type wave3Runtime struct{ executes atomic.Int32 }

func (d *wave3Runtime) Execute(_ context.Context, _ record, _ string, _ func(string, string)) execution {
	d.executes.Add(1)
	return execution{ExitCode: 1}
}
func (d *wave3Runtime) Remove(context.Context, record) error { return nil }

func TestM10ZWave3RedFakeWSReplayNeedsTransportObservation(t *testing.T) {
	t.Setenv("WHIPPET_M109_DIAGNOSTICS", "1")
	workDir := t.TempDir()
	m, err := New(Config{ServerURL: "http://server.invalid", Token: "synthetic", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: workDir, MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "complete", Reclaimed: true, ResultMessageID: newID(), Result: &Result{Status: "failed"}}
	if err := m.store(r); err != nil {
		t.Fatal(err)
	}
	received := make(chan Envelope, 3)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		for i := 0; i < 3; i++ {
			var env Envelope
			if websocket.JSON.Receive(conn, &env) != nil {
				return
			}
			received <- env
		}
	}))
	defer server.Close()
	m.cfg.ServerURL = server.URL
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = m.session(ctx)
	for _, kind := range []string{"hello", "heartbeat", "result"} {
		select {
		case env := <-received:
			if env.Type != kind {
				t.Fatalf("unexpected wire stage: %s", env.Type)
			}
			if kind == "result" && (env.MessageID != r.ResultMessageID || env.RunID != r.RunID || env.AttemptID != r.AttemptID) {
				t.Fatal("immutable result replay changed")
			}
		case <-ctx.Done():
			t.Fatal("fake WS did not receive expected replay")
		}
	}
	if saved := m.snapshot(); len(saved) != 1 || saved[0].Phase != "complete" || !saved[0].Reclaimed || saved[0].ResultMessageID != r.ResultMessageID {
		t.Fatal("replay changed durable record")
	}
	path := filepath.Join(workDir, "diagnostics", "manager-transport.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatal("MISSING_OBSERVATION: fake WS replay sent result, but no bounded connection/result-send stage evidence exists")
	}
	for _, path := range []string{path} {
		info, e := os.Lstat(path)
		if e != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
			t.Fatal("transport evidence boundary")
		}
		body, e := os.ReadFile(path)
		if e != nil || strings.Contains(string(body), r.RunID) || strings.Contains(string(body), r.AttemptID) || strings.Contains(string(body), "synthetic") {
			t.Fatal("transport evidence contains private or free text")
		}
		var got map[string]any
		if json.Unmarshal(body, &got) != nil || len(got) != 7 || got["schemaVersion"] != float64(1) || got["connectionAttemptCount"] != float64(1) || got["resultSendCount"] != float64(1) || got["replayCount"] != float64(1) || got["resultSendStage"] != "SENT" || got["connectionStage"] != "DISCONNECTED" {
			t.Fatal("transport stage shape")
		}
	}
}

func TestM10ZWave3FakeRuntimeReconnectReplaysSameResultOnce(t *testing.T) {
	t.Setenv("WHIPPET_M109_DIAGNOSTICS", "1")
	m, err := New(Config{ServerURL: "http://server.invalid", Token: "synthetic", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	runtime := &wave3Runtime{}
	m.docker = runtime
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dispatch := dispatchForTest()
	_ = m.accept(ctx, dispatch) // The first ACK is offline; the accepted attempt still executes once.
	m.wg.Wait()
	saved := m.snapshot()
	if len(saved) != 1 || saved[0].Phase != "complete" || !saved[0].Reclaimed || saved[0].Result == nil || saved[0].Result.Status != "failed" || runtime.executes.Load() != 1 {
		t.Fatal("fake runtime did not complete once")
	}
	messageID := saved[0].ResultMessageID
	received := make(chan Envelope, 6)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		for i := 0; i < 3; i++ {
			var env Envelope
			if websocket.JSON.Receive(conn, &env) != nil {
				return
			}
			received <- env
		}
	}))
	defer server.Close()
	m.cfg.ServerURL = server.URL
	for session := 0; session < 2; session++ {
		_ = m.session(ctx)
		for _, kind := range []string{"hello", "heartbeat", "result"} {
			select {
			case env := <-received:
				if env.Type != kind || kind == "result" && env.MessageID != messageID {
					t.Fatal("replay sequence or immutable messageId changed")
				}
			case <-ctx.Done():
				t.Fatal("fake WS reconnect timed out")
			}
		}
	}
	if runtime.executes.Load() != 1 || m.snapshot()[0].ResultMessageID != messageID || m.snapshot()[0].Result.Status != "failed" {
		t.Fatal("reconnect re-executed or changed result")
	}
	raw, err := os.ReadFile(filepath.Join(m.cfg.WorkDir, "diagnostics", "manager-transport.json"))
	if err != nil {
		t.Fatal("missing transport snapshot")
	}
	var got map[string]any
	if json.Unmarshal(raw, &got) != nil || len(got) != 7 || got["connectionAttemptCount"] != float64(2) || got["replayCount"] != float64(2) || got["resultSendCount"] != float64(3) || got["resultSendStage"] != "SENT" {
		t.Fatal("replay transport counts")
	}
}

func TestM10ZWave3TransportOffAndNoFollow(t *testing.T) {
	t.Setenv("WHIPPET_M109_DIAGNOSTICS", "0")
	m, err := New(Config{ServerURL: "http://server.invalid", Token: "synthetic", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.transport.connection("DIAL_START")
	if _, err := os.Stat(filepath.Join(m.cfg.WorkDir, "diagnostics", "manager-transport.json")); !os.IsNotExist(err) {
		t.Fatal("off mode wrote transport evidence")
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "diagnostics")); err != nil {
		t.Fatal(err)
	}
	d := newManagerTransportDiagnostic(root)
	d.connection("DIAL_START")
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("transport writer followed directory symlink")
	}
	root = t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "diagnostics"), 0700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(outside, "sentinel")
	if err := os.WriteFile(target, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "diagnostics", "manager-transport.json")); err != nil {
		t.Fatal(err)
	}
	d = newManagerTransportDiagnostic(root)
	d.connection("DIAL_START")
	unchanged, err := os.ReadFile(target)
	if err != nil || string(unchanged) != "unchanged" {
		t.Fatal("transport writer followed file symlink")
	}
	info, err := os.Lstat(filepath.Join(root, "diagnostics", "manager-transport.json"))
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 4096 {
		t.Fatal("transport file mode or size")
	}
}

func TestM10ZWave3TransportObservationCannotChangeResult(t *testing.T) {
	for _, mode := range []string{"off", "on", "writer_blocked"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "off" {
				t.Setenv("WHIPPET_M109_DIAGNOSTICS", "0")
			} else {
				t.Setenv("WHIPPET_M109_DIAGNOSTICS", "1")
			}
			m, err := New(Config{ServerURL: "http://server.invalid", Token: "synthetic", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			if mode == "writer_blocked" {
				if err := os.WriteFile(filepath.Join(m.cfg.WorkDir, "diagnostics"), []byte("blocked"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			runtime := &wave3Runtime{}
			m.docker = runtime
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = m.accept(ctx, dispatchForTest())
			m.wg.Wait()
			saved := m.snapshot()
			if len(saved) != 1 || saved[0].Phase != "complete" || !saved[0].Reclaimed || saved[0].Result == nil || saved[0].Result.Status != "failed" || runtime.executes.Load() != 1 {
				t.Fatal("observation changed terminal result or execution count")
			}
			_, statErr := os.Stat(filepath.Join(m.cfg.WorkDir, "diagnostics", "manager-transport.json"))
			if mode == "on" && statErr != nil || mode != "on" && statErr == nil {
				t.Fatal("observation gate or writer failure behavior")
			}
		})
	}
}

func TestM10ZWave3LateHeartbeatCannotReplaceDisconnectedStage(t *testing.T) {
	d := newManagerTransportDiagnostic(t.TempDir())
	first := d.connection("DIAL_START")
	d.connection("DISCONNECTED", first)
	d.connection("HEARTBEAT_SENT", first)
	if d.connectionStage != "DISCONNECTED" {
		t.Fatal("late heartbeat changed disconnected stage")
	}
	second := d.connection("DIAL_START")
	if second == first {
		t.Fatal("connection generation did not advance")
	}
	d.connection("HEARTBEAT_SENT", first)
	if d.connectionStage != "DIAL_START" {
		t.Fatal("old session heartbeat changed new connection")
	}
}
