package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestRunLiveDiagnosticRejectedInactive(t *testing.T) {
	run, attempt, viewer := newID(), newID(), newID()
	work := t.TempDir()
	m := &Manager{cfg: Config{ManagerID: "fixture", WorkDir: work}, records: map[string]record{}}
	err := m.startLive(context.Background(), message("fixture", "live.start", run, attempt, liveStart{ViewerID: viewer, ICE: json.RawMessage(`[]`)}))
	if err == nil {
		t.Fatal("inactive Live command was accepted")
	}
	raw, err := os.ReadFile(filepath.Join(work, "diagnostics", "run-"+attempt+"-"+viewer+".json"))
	if err != nil {
		t.Fatal("normal Run Live fixed diagnostic missing")
	}
	var diagnostic struct {
		RunID     string `json:"runId"`
		AttemptID string `json:"attemptId"`
		ViewerID  string `json:"viewerId"`
		Events    []struct {
			Stage  string `json:"stage"`
			Error  string `json:"error"`
			Phase  string `json:"recordPhase"`
			Active bool   `json:"active"`
		} `json:"events"`
	}
	if json.Unmarshal(raw, &diagnostic) != nil || diagnostic.RunID != run || diagnostic.AttemptID != attempt || diagnostic.ViewerID != viewer {
		t.Fatal("normal Run Live diagnostic binding invalid")
	}
	if len(diagnostic.Events) != 2 || diagnostic.Events[0].Stage != "command_received" || diagnostic.Events[1].Stage != "command_rejected" ||
		diagnostic.Events[1].Error != "attempt_inactive" || diagnostic.Events[1].Phase != "missing" || diagnostic.Events[1].Active {
		t.Fatal("normal Run Live rejection stages invalid")
	}
}

func TestRunLiveDiagnosticMediaStages(t *testing.T) {
	run, attempt, viewer := newID(), newID(), newID()
	frame := make(chan struct{}, 1)
	server := httptest.NewServer(websocket.Handler(func(conn *websocket.Conn) {
		defer conn.Close()
		for {
			var data []byte
			if websocket.Message.Receive(conn, &data) != nil {
				return
			}
			if len(data) > 1 && data[0] == 0xff && data[1] == 0xd8 {
				frame <- struct{}{}
				return
			}
			var wire liveWire
			if json.Unmarshal(data, &wire) == nil && wire.Type == "ping" {
				_ = websocket.JSON.Send(conn, liveWire{Type: "mode", Mode: "jpeg"})
			}
		}
	}))
	defer server.Close()
	work := t.TempDir()
	m, err := New(Config{ServerURL: server.URL, Token: "synthetic-token", ManagerID: "fixture", MaxWorkers: 1, WorkDir: work})
	if err != nil {
		t.Fatal("Manager fixture unavailable")
	}
	defer m.Close()
	r := record{RunID: run, AttemptID: attempt, Phase: "running"}
	m.records[attempt] = r
	if err := m.prepare(r, Dispatch{Script: "fixture", TimeoutMS: 1000}); err != nil {
		t.Fatal("task fixture unavailable")
	}
	liveDir := filepath.Join(m.taskDir(r), "live")
	state, _ := json.Marshal(liveState{ViewerID: viewer, State: "streaming", Transport: "jpeg"})
	if os.WriteFile(filepath.Join(liveDir, "state.json"), state, 0600) != nil ||
		os.WriteFile(filepath.Join(liveDir, viewer+".jpg"), []byte{0xff, 0xd8, 0xff, 0xd9}, 0600) != nil {
		t.Fatal("media fixture unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.startLive(ctx, message("fixture", "live.start", run, attempt, liveStart{ViewerID: viewer, ICE: json.RawMessage(`[]`)})); err != nil {
		t.Fatal("active Live command rejected")
	}
	select {
	case <-frame:
	case <-ctx.Done():
		t.Fatal("first JPEG frame not forwarded")
	}
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("media diagnostic did not close")
	}
	path := filepath.Join(work, "diagnostics", "run-"+attempt+"-"+viewer+".json")
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > maxRunLiveDiagnosticBytes {
		t.Fatal("bounded normal Run Live diagnostic unavailable")
	}
	var diagnostic runLiveDiagnostic
	if json.Unmarshal(raw, &diagnostic) != nil || diagnostic.RunID != run || diagnostic.AttemptID != attempt || diagnostic.ViewerID != viewer {
		t.Fatal("normal Run Live diagnostic binding invalid")
	}
	if len(diagnostic.Events) == 0 || diagnostic.Events[0].RecordPhase != "running" || !diagnostic.Events[0].Active {
		t.Fatal("normal Run Live record phase or active state missing")
	}
	stages := map[string]bool{}
	for _, event := range diagnostic.Events {
		stages[event.Stage] = true
		if !runLiveStages[event.Stage] || !runLiveErrors[event.Error] || !runLivePhases[event.RecordPhase] || event.At.IsZero() {
			t.Fatal("unbounded normal Run Live event")
		}
	}
	for _, stage := range []string{"command_received", "media_connecting", "media_connected", "control_written", "state_forwarded", "frame_forwarded", "closed"} {
		if !stages[stage] {
			t.Fatal("normal Run Live fixed stage missing", stage)
		}
	}
	if bytes.Contains(raw, []byte("synthetic-token")) || bytes.Contains(raw, []byte("127.0.0.1")) || bytes.Contains(raw, []byte("fixture")) {
		t.Fatal("normal Run Live diagnostic retained transport or fixture content")
	}
}

func TestRunLiveDiagnosticMediaConnectFailure(t *testing.T) {
	run, attempt, viewer := newID(), newID(), newID()
	work := t.TempDir()
	m := &Manager{cfg: Config{ManagerID: "fixture", ServerURL: "http://127.0.0.1:1", Token: "synthetic-secret", WorkDir: work},
		records: map[string]record{attempt: {RunID: run, AttemptID: attempt, Phase: "running"}}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := m.startLive(ctx, message("fixture", "live.start", run, attempt, liveStart{ViewerID: viewer, ICE: json.RawMessage(`[]`)})); err != nil {
		t.Fatal("active Live command rejected")
	}
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("media connection failure did not close")
	}
	raw, err := os.ReadFile(filepath.Join(work, "diagnostics", "run-"+attempt+"-"+viewer+".json"))
	if err != nil || bytes.Contains(raw, []byte("synthetic-secret")) || bytes.Contains(raw, []byte("127.0.0.1")) {
		t.Fatal("media diagnostic unavailable or leaked connection data")
	}
	var diagnostic runLiveDiagnostic
	if json.Unmarshal(raw, &diagnostic) != nil || len(diagnostic.Events) != 4 || diagnostic.Events[0].Stage != "command_received" ||
		diagnostic.Events[1].Stage != "media_connecting" || diagnostic.Events[2].Stage != "media_failed" ||
		diagnostic.Events[2].Error != "media_connect_failed" || diagnostic.Events[3].Stage != "closed" {
		t.Fatal("media connection failure stages invalid")
	}
}

func TestRunLiveDiagnosticRejectsSymlinksAndBoundsEvents(t *testing.T) {
	run, attempt, viewer := newID(), newID(), newID()
	work, outside := t.TempDir(), t.TempDir()
	m := &Manager{cfg: Config{WorkDir: work}, records: map[string]record{attempt: {RunID: run, AttemptID: attempt, Phase: "running"}}}
	dir := filepath.Join(work, "diagnostics")
	if os.Symlink(outside, dir) != nil {
		t.Fatal("symlink fixture unavailable")
	}
	m.recordRunLiveDiagnostic(run, attempt, viewer, "command_received", "none")
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("diagnostic followed directory symlink")
	}
	if os.Remove(dir) != nil || os.Mkdir(dir, 0700) != nil {
		t.Fatal("diagnostic directory fixture unavailable")
	}
	name := "run-" + attempt + "-" + viewer + ".json"
	target := filepath.Join(outside, "sentinel")
	if os.WriteFile(target, []byte("untouched"), 0600) != nil || os.Symlink(target, filepath.Join(dir, name)) != nil {
		t.Fatal("diagnostic file symlink fixture unavailable")
	}
	m.recordRunLiveDiagnostic(run, attempt, viewer, "command_received", "none")
	sentinel, _ := os.ReadFile(target)
	if string(sentinel) != "untouched" {
		t.Fatal("diagnostic followed file symlink")
	}
	if os.Remove(filepath.Join(dir, name)) != nil {
		t.Fatal("diagnostic file symlink cleanup failed")
	}
	m.recordRunLiveDiagnostic(run, attempt, viewer, "unknown_stage", "none")
	m.recordRunLiveDiagnostic(run, attempt, viewer, "command_received", "free-form-error")
	m.recordRunLiveDiagnostic("invalid-run", attempt, viewer, "command_received", "none")
	m.recordRunLiveDiagnostic(run, attempt, "invalid-viewer", "command_received", "none")
	if _, err := os.Lstat(filepath.Join(dir, name)); !os.IsNotExist(err) {
		t.Fatal("diagnostic accepted unknown enum")
	}
	for i := 0; i < 40; i++ {
		stage := "command_received"
		if i%2 != 0 {
			stage = "media_connecting"
		}
		m.recordRunLiveDiagnostic(run, attempt, viewer, stage, "none")
	}
	path := filepath.Join(dir, name)
	info, err := os.Stat(path)
	if err != nil || info.Size() > maxRunLiveDiagnosticBytes || info.Mode().Perm() != 0600 {
		t.Fatal("diagnostic file bounds or mode invalid")
	}
	dirInfo, err := os.Stat(dir)
	if err != nil || dirInfo.Mode().Perm() != 0700 {
		t.Fatal("diagnostic directory mode invalid")
	}
	raw, err := os.ReadFile(path)
	var diagnostic runLiveDiagnostic
	if err != nil || json.Unmarshal(raw, &diagnostic) != nil || len(diagnostic.Events) != maxRunLiveDiagnosticEvents {
		t.Fatal("diagnostic event count invalid")
	}
}
