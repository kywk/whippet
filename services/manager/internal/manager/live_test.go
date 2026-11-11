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

func TestLiveStopMatchesCurrentViewer(t *testing.T) {
	viewer, oldViewer, attempt, run := newID(), newID(), newID(), newID()
	var stopped atomic.Int32
	m := &Manager{cfg: Config{ManagerID: "fixture"}, records: map[string]record{attempt: {RunID: run}}, live: map[string]*liveSession{attempt: {viewerID: viewer, cancel: func() { stopped.Add(1) }}}}
	if err := m.stopLive(message("fixture", "live.stop", run, attempt, liveStart{ViewerID: oldViewer})); err != nil {
		t.Fatal(err)
	}
	if stopped.Load() != 0 {
		t.Fatal("old viewer stopped current session")
	}
	if err := m.stopLive(message("fixture", "live.stop", run, attempt, liveStart{ViewerID: viewer})); err != nil {
		t.Fatal(err)
	}
	if stopped.Load() != 1 {
		t.Fatal("current viewer was not stopped")
	}
}

func TestLiveMediaLeaseAndJPEGAreIndependent(t *testing.T) {
	r := record{RunID: newID(), AttemptID: newID(), Phase: "running"}
	viewer := newID()
	frames := make(chan struct{}, 1)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		if conn.Request().Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Error("missing media authorization")
			return
		}
		if conn.Request().URL.Query().Get("viewerId") != viewer {
			t.Error("viewer binding mismatch")
			return
		}
		for {
			var data []byte
			if websocket.Message.Receive(conn, &data) != nil {
				return
			}
			if len(data) > 1 && data[0] == 0xff && data[1] == 0xd8 {
				frames <- struct{}{}
				return
			}
			var v liveWire
			if json.Unmarshal(data, &v) == nil && v.Type == "ping" {
				_ = websocket.JSON.Send(conn, liveWire{Type: "pong"})
				_ = websocket.JSON.Send(conn, liveWire{Type: "mode", Mode: "jpeg"})
			}
		}
	}))
	defer server.Close()
	m, err := New(Config{ServerURL: server.URL, Token: "synthetic-token", ManagerID: "fixture", MaxWorkers: 1, WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.records[r.AttemptID] = r
	if err := m.prepare(r, Dispatch{Script: "fixture", TimeoutMS: 1000}); err != nil {
		t.Fatal(err)
	}
	liveDir := filepath.Join(m.taskDir(r), "live")
	state, _ := json.Marshal(liveState{ViewerID: viewer, State: "streaming", Transport: "jpeg"})
	if err := os.WriteFile(filepath.Join(liveDir, "state.json"), state, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(liveDir, viewer+".jpg"), []byte{0xff, 0xd8, 0xff, 0xd9}, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- m.mediaSession(ctx, r, liveStart{ViewerID: viewer, ICE: json.RawMessage(`[]`)}) }()
	select {
	case <-frames:
	case <-ctx.Done():
		t.Fatal("media JPEG was not delivered")
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("media disconnect did not stop session")
	}
	data, err := os.ReadFile(filepath.Join(liveDir, "control.json"))
	if err != nil {
		t.Fatal(err)
	}
	var control liveControl
	if json.Unmarshal(data, &control) != nil || control.Expires != 0 || control.ViewerID != viewer {
		t.Fatal("lease not revoked on disconnect")
	}
	if strings.Contains(string(data), "synthetic-token") {
		t.Fatal("Manager token leaked to Worker")
	}
	if m.records[r.AttemptID].Phase != "running" {
		t.Fatal("media changed task state")
	}
	root, err := os.OpenRoot(liveDir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := os.Symlink("state.json", filepath.Join(liveDir, "symlink")); err != nil {
		t.Fatal(err)
	}
	if _, err := liveRead(root, "symlink", maxLiveJSON); err == nil {
		t.Fatal("media accepted symlink")
	}
	if _, err := liveRead(root, "state.json", 1); err == nil {
		t.Fatal("media accepted oversized file")
	}
}
