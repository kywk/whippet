package manager

import (
	"context"
	"encoding/json"
	"golang.org/x/net/websocket"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLiveSensitiveWireResumeBeforeJPEGAndLateAnswerDoesNotStopRun(t *testing.T) {
	r := record{RunID: newID(), AttemptID: newID(), Phase: "running"}
	viewer := newID()
	paused, frame := make(chan struct{}, 1), make(chan string, 1)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		reason := ""
		for {
			var raw []byte
			if websocket.Message.Receive(conn, &raw) != nil {
				return
			}
			if len(raw) > 1 && raw[0] == 0xff {
				frame <- reason
				return
			}
			var v liveWire
			if json.Unmarshal(raw, &v) != nil {
				continue
			}
			if v.Type == "ping" {
				_ = websocket.JSON.Send(conn, liveWire{Type: "pong"})
				_ = websocket.JSON.Send(conn, liveWire{Type: "mode", Mode: "jpeg"})
				_ = websocket.JSON.Send(conn, liveWire{Type: "answer", SDP: "late answer", OfferID: newID()})
			}
			if v.Type == "state" {
				reason = v.Reason
				if reason == "sensitive_input" {
					select {
					case paused <- struct{}{}:
					default:
					}
				}
			}
		}
	}))
	defer server.Close()
	m, err := New(Config{ServerURL: server.URL, Token: "synthetic", ManagerID: "fixture", MaxWorkers: 1, WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.records[r.AttemptID] = r
	if err = m.prepare(r, Dispatch{Script: "fixture", TimeoutMS: 1000}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(m.taskDir(r), "live")
	writeState := func(reason string) {
		t.Helper()
		if err := atomicJSON(filepath.Join(dir, "state.json"), liveState{ViewerID: viewer, State: "waiting", Reason: reason, Transport: "jpeg"}); err != nil {
			t.Fatal(err)
		}
	}
	writeState("sensitive_input")
	if err := os.WriteFile(filepath.Join(dir, viewer+".jpg"), []byte{0xff, 0xd8, 0xff, 0xd9}, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- m.mediaSession(ctx, r, liveStart{ViewerID: viewer, ICE: json.RawMessage(`[]`)}) }()
	select {
	case <-paused:
	case <-ctx.Done():
		t.Fatal("pause reason was not forwarded")
	}
	select {
	case <-frame:
		t.Fatal("JPEG escaped sensitive pause")
	case <-time.After(250 * time.Millisecond):
	}
	writeState("sensitive_input_complete")
	select {
	case reason := <-frame:
		if reason != "sensitive_input_complete" {
			t.Fatal("JPEG preceded public resume marker", reason)
		}
	case <-ctx.Done():
		t.Fatal("JPEG did not resume")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("media cleanup hung")
	}
	if m.records[r.AttemptID].Phase != "running" || m.records[r.AttemptID].CancelRequested {
		t.Fatal("media pause changed the Run")
	}
}
