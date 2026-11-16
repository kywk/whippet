package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// Opt-in: PM supplies an isolated image built from the current Worker Dockerfile.
// The target site is synthetic and lives only for this test. Docker on macOS can
// reach the host listener through host.docker.internal.
func TestM11SessionRealDockerBrowserAndReclaim(t *testing.T) {
	image := os.Getenv("WHIPPET_M11_WORKER_IMAGE")
	if image == "" {
		t.Skip("set WHIPPET_M11_WORKER_IMAGE to an isolated current Worker image")
	}
	var clicks atomic.Int32
	page := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.URL.Path == "/clicked" && r.Method == http.MethodPost {
			clicks.Add(1)
			_, _ = w.Write([]byte("<!doctype html><title>Whippet M11 clicked</title><p>completed</p>"))
			return
		}
		if r.URL.Path != "/" || r.Method != http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte("<!doctype html><title>Whippet M11 fixture</title><form method=post action=/clicked><input id=note name=note><button id=go type=submit>Go</button></form>"))
	})
	site := httptest.NewUnstartedServer(page)
	listener, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	site.Listener.Close()
	site.Listener = listener
	site.Start()
	defer site.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	origin := "http://host.docker.internal:" + strconv.Itoa(port)

	m, err := New(Config{ServerURL: "http://server.invalid", ManagerID: "m11-test-" + newID(), WorkerImage: image, WorkDir: t.TempDir(), MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer func() { cancel(); m.wg.Wait(); _ = m.Close() }()
	received := make(chan Envelope, 16)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		for {
			var event Envelope
			if websocket.JSON.Receive(conn, &event) != nil {
				return
			}
			select {
			case received <- event:
			case <-ctx.Done():
				return
			}
		}
	}))
	defer server.Close()
	ws, err := websocket.NewConfig("ws"+strings.TrimPrefix(server.URL, "http"), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := ws.DialContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	m.setConn(conn)
	read := func(want string) Envelope {
		t.Helper()
		select {
		case event := <-received:
			if event.Type != want {
				t.Fatalf("wanted %s, got %s", want, event.Type)
			}
			return event
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s", want)
			return Envelope{}
		}
	}
	workspaceID, sessionID, leaseID := newID(), newID(), newID()
	workspace := map[string]any{
		"schemaVersion": "1", "workspaceId": workspaceID, "settingsRevision": 1,
		"config": map[string]any{
			"name": "fixture", "purpose": "", "backgroundSummary": "", "targets": []any{map[string]string{"name": "site", "purpose": "", "origin": origin}},
			"dependencies": []any{}, "excludedOrigins": []any{}, "exclusions": "", "loginRoles": []any{}, "defaultTestUrl": "", "timeoutMs": 60000,
		},
		"roleRefs": []any{},
	}
	contextJSON, err := json.Marshal(workspace)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	allowed := []string{"browser_navigate", "browser_snapshot", "browser_click", "browser_fill"}
	open := sessionOpen{SessionID: sessionID, LeaseID: leaseID, WorkspaceID: workspaceID, WorkspaceContext: contextJSON, AllowedTools: allowed, ToolRegistryVersion: registry.Version, ToolRegistrySHA256: registry.SHA256, IdleTimeoutMS: 600000, MaxLifetimeMS: 1800000}
	if err := m.openSession(ctx, message(m.cfg.ManagerID, "session.open", "", "", open)); err != nil {
		t.Fatal(err)
	}
	ready := read("session.ready")
	var readyID sessionClose
	if json.Unmarshal(ready.Payload, &readyID) != nil || readyID.SessionID != sessionID || readyID.LeaseID != leaseID {
		t.Fatal("wrong session became ready")
	}
	if m.sessionSlotCount() != 1 {
		t.Fatal("real Docker session did not hold its slot")
	}
	call := func(id, name string, args json.RawMessage) sessionToolResult {
		t.Helper()
		command := sessionToolCall{SessionID: sessionID, LeaseID: leaseID, CallID: id, Name: name, Arguments: args}
		if err := m.callSession(ctx, message(m.cfg.ManagerID, "session.call", "", "", command)); err != nil {
			t.Fatal(err)
		}
		var reply sessionToolResult
		if json.Unmarshal(read("session.reply").Payload, &reply) != nil || reply.SessionID != sessionID || reply.LeaseID != leaseID || reply.CallID != id || reply.Error != "" || len(reply.Result) == 0 {
			t.Fatal("real Docker browser call failed or returned a wrong lease")
		}
		return reply
	}
	urlArg, _ := json.Marshal(map[string]string{"url": origin})
	if result := call(newID(), "browser_navigate", urlArg).Result; !bytes.Contains(result, []byte(`"snapshot"`)) || !bytes.Contains(result, []byte("Go")) {
		t.Fatal("navigation did not reach the isolated fixture")
	}
	_ = call(newID(), "browser_snapshot", json.RawMessage(`{}`))
	_ = call(newID(), "browser_fill", json.RawMessage(`{"selector":"#note","value":"synthetic"}`))
	clickID := newID()
	first := call(clickID, "browser_click", json.RawMessage(`{"selector":"#go"}`))
	if clicks.Load() != 1 {
		t.Fatal("first browser click did not submit exactly once")
	}
	second := call(clickID, "browser_click", json.RawMessage(`{"selector":"#go"}`))
	if !bytes.Equal(first.Result, second.Result) || clicks.Load() != 1 {
		t.Fatal("replayed callId repeated a browser effect")
	}
	if err := m.closeSession(message(m.cfg.ManagerID, "session.close", "", "", sessionClose{sessionID, leaseID})); err != nil {
		t.Fatal(err)
	}
	var final struct {
		SessionID string `json:"sessionId"`
		LeaseID   string `json:"leaseId"`
		Reason    string `json:"reason"`
		Reclaimed bool   `json:"reclaimed"`
	}
	seenPending := false
	for !final.Reclaimed {
		if json.Unmarshal(read("session.closed").Payload, &final) != nil || final.SessionID != sessionID || final.LeaseID != leaseID || final.Reason != "closed" {
			t.Fatal("wrong Docker close result")
		}
		if !final.Reclaimed {
			seenPending = true
		}
	}
	if !seenPending {
		t.Fatal("real Docker cleanup skipped the pending state")
	}
	if m.sessionSlotCount() != 0 {
		t.Fatal("slot remained held after confirmed Docker removal")
	}
	if err := m.closeSession(message(m.cfg.ManagerID, "session.close", "", "", sessionClose{sessionID, leaseID})); err != nil {
		t.Fatal(err)
	}
	var replay struct {
		Reclaimed bool `json:"reclaimed"`
	}
	if json.Unmarshal(read("session.closed").Payload, &replay) != nil || !replay.Reclaimed {
		t.Fatal("reclaimed Docker close was not replayed")
	}
}
