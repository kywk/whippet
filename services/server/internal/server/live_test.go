package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

type liveTestStore struct {
	Store
	target LiveTarget
}

func (s *liveTestStore) LiveTarget(context.Context, string) (LiveTarget, error) { return s.target, nil }

type liveTestController struct {
	epoch    string
	commands []LiveCommand
}

func (c *liveTestController) LiveManagerEpoch(id string) (string, bool) {
	return c.epoch, id == "manager-test"
}
func (c *liveTestController) QueueLiveCommand(command LiveCommand) error {
	c.commands = append(c.commands, command)
	return nil
}

func liveFixture() (*LiveHub, *liveTestStore, *liveTestController) {
	store := &liveTestStore{target: LiveTarget{RunID: NewID(), TestID: NewID(), WorkspaceID: NewID(), ManagerID: "manager-test", AttemptID: NewID(), Status: "running"}}
	controller := &liveTestController{epoch: "epoch-1"}
	return NewLiveHub(store, controller, nil), store, controller
}

func TestLiveBindingBusyAndViewerLease(t *testing.T) {
	ctx := context.Background()
	hub, store, controller := liveFixture()
	now := time.Now()
	hub.now = func() time.Time { return now }
	s, err := hub.OpenViewer(ctx, store.target.RunID)
	if err != nil {
		t.Fatal(err)
	}
	ready := <-s.Viewer.Messages
	if ready.Type != "ready" || ready.ViewerID != s.ViewerID || ready.ICEServers == nil || len(*ready.ICEServers) != 0 {
		t.Fatal("invalid ready")
	}
	if _, err := hub.OpenViewer(ctx, store.target.RunID); err == nil {
		t.Fatal("second viewer accepted")
	}
	if _, _, err := hub.AttachMedia(ctx, store.target.RunID, NewID(), s.ViewerID); err == nil {
		t.Fatal("wrong attempt accepted")
	}
	if _, _, err := hub.AttachMedia(ctx, store.target.RunID, store.target.AttemptID, NewID()); err == nil {
		t.Fatal("wrong viewer accepted")
	}
	controller.epoch = "epoch-2"
	if _, _, err := hub.AttachMedia(ctx, store.target.RunID, store.target.AttemptID, s.ViewerID); err == nil {
		t.Fatal("old control epoch accepted")
	}
	controller.epoch = "epoch-1"
	_, media, err := hub.AttachMedia(ctx, store.target.RunID, store.target.AttemptID, s.ViewerID)
	if err != nil {
		t.Fatal(err)
	}
	if mode := <-media.Messages; mode.Type != "mode" || mode.Mode != "webrtc" {
		t.Fatal("initial mode must be webrtc")
	}
	now = now.Add(20 * time.Second)
	if err := hub.ViewerMessage(s, LiveMessage{Type: "ping"}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(29 * time.Second)
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "ping"}); err != nil {
		t.Fatal(err)
	}
	if pong := <-media.Messages; pong.Type != "pong" {
		t.Fatal("media ping must receive pong")
	}
	now = now.Add(2 * time.Second)
	hub.Sweep(ctx, now)
	select {
	case <-s.Viewer.Done:
	default:
		t.Fatal("media ping renewed expired viewer lease")
	}
	if len(controller.commands) != 2 || controller.commands[1].Type != "live.stop" || controller.commands[1].ViewerID != s.ViewerID {
		t.Fatal("lease cleanup did not stop exact viewer")
	}
	if store.target.Status != "running" {
		t.Fatal("live expiry changed Run state")
	}
}

func TestLiveLatestJPEGAndOldSessionCannotStopNewViewer(t *testing.T) {
	ctx := context.Background()
	hub, store, controller := liveFixture()
	s, err := hub.OpenViewer(ctx, store.target.RunID)
	if err != nil {
		t.Fatal(err)
	}
	_, media, err := hub.AttachMedia(ctx, store.target.RunID, store.target.AttemptID, s.ViewerID)
	if err != nil {
		t.Fatal(err)
	}
	if err := hub.ViewerMessage(s, LiveMessage{Type: "mode", Mode: "jpeg"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		if err := hub.Frame(s, media, []byte{0xff, 0xd8, byte(i % 256), 0xff, 0xd9}); err != nil {
			t.Fatal(err)
		}
	}
	if len(s.Viewer.Frames) != 1 || (<-s.Viewer.Frames).JPEG[2] != byte(999%256) {
		t.Fatal("slow viewer did not retain only newest JPEG")
	}
	if len(controller.commands) != 1 {
		t.Fatal("frames entered control queue")
	}
	if err := hub.Frame(s, media, make([]byte, MaxLiveFrameBytes+1)); err == nil {
		t.Fatal("oversized frame accepted")
	}
	hub.CloseMedia(s, media)
	select {
	case <-s.Viewer.Done:
	default:
		t.Fatal("media disconnect left viewer alive")
	}
	if store.target.Status != "running" {
		t.Fatal("media disconnect changed Run")
	}
	newViewer, err := hub.OpenViewer(ctx, store.target.RunID)
	if err != nil {
		t.Fatal(err)
	}
	hub.CloseViewer(s)
	hub.CloseMedia(s, media)
	select {
	case <-newViewer.Viewer.Done:
		t.Fatal("old close stopped a later viewer")
	default:
	}
	hub.EndRun(store.target.RunID)
	select {
	case <-newViewer.Viewer.Done:
	default:
		t.Fatal("terminal cleanup failed")
	}
	if newViewer.Viewer.Final().State != "ended" {
		t.Fatal("terminal state missing")
	}
}

type liveFlowStore struct{ *flowStore }

func (s *liveFlowStore) LiveTarget(ctx context.Context, id string) (LiveTarget, error) {
	run, err := s.Run(ctx, id)
	if err != nil {
		return LiveTarget{}, err
	}
	target := LiveTarget{RunID: id, TestID: stringValue(run.TestID), Status: run.Status}
	if assigned := s.assigned[id]; assigned != nil {
		target.ManagerID, target.AttemptID = assigned.ManagerID, assigned.AttemptID
	}
	return target, nil
}

func TestLiveControlBindingAndEngineTerminalCleanup(t *testing.T) {
	ctx := context.Background()
	store := &liveFlowStore{newFlowStore()}
	run, _ := store.CreateRun(ctx, store.testID)
	engine := NewEngine(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	peer := &recordPeer{}
	manager, err := engine.Attach(ctx, "manager-test", 1, peer)
	if err != nil {
		t.Fatal(err)
	}
	testHeartbeat(t, engine, manager, nil)
	if err := engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	hub := NewLiveHub(store, engine, nil)
	engine.SetLiveHub(hub)
	viewer, err := hub.OpenViewer(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	command := <-engine.liveCommands
	if err := engine.sendLiveCommand(ctx, command); err != nil {
		t.Fatal(err)
	}
	if peer.messages[1].Type != "live.start" || peer.messages[1].AttemptID != store.assigned[run.ID].AttemptID {
		t.Fatal("live start binding incorrect")
	}
	old := command
	old.ManagerEpoch = "previous-epoch"
	if err := engine.sendLiveCommand(ctx, old); err == nil {
		t.Fatal("old Manager epoch received live start")
	}
	if err := engine.Handle(ctx, manager, NewEnvelope("result", "manager-test", run.ID, store.assigned[run.ID].AttemptID, Result{Status: "failed"})); err != nil {
		t.Fatal(err)
	}
	select {
	case <-viewer.Viewer.Done:
	default:
		t.Fatal("result did not close live session")
	}
	stop := <-engine.liveCommands
	if stop.Type != "live.stop" || stop.ViewerID != viewer.ViewerID {
		t.Fatal("terminal cleanup stop mismatch")
	}
	if err := engine.sendLiveCommand(ctx, stop); err != nil {
		t.Fatal("stop must remain valid after terminal", err)
	}
}

func TestLiveICEConfigurationDoesNotExposeCredentialsInErrors(t *testing.T) {
	servers, err := ParseICEServers(`[{"urls":["turn:relay.test:3478"],"username":"viewer","credential":"canary-turn-secret"}]`)
	if err != nil || len(servers) != 1 || servers[0].Credential != "canary-turn-secret" {
		t.Fatal("valid TURN configuration rejected")
	}
	for _, raw := range []string{`{"credential":"canary-turn-secret"}`, `[{"urls":"https://invalid.test","credential":"canary-turn-secret"}]`, `null`} {
		_, err := ParseICEServers(raw)
		if err == nil || strings.Contains(err.Error(), "canary") {
			t.Fatal("invalid config accepted or credentials exposed", err)
		}
	}
	if _, err := ParseICEServers(""); err != nil {
		t.Fatal(err)
	}
	var liveError *LiveError
	if !errors.As(&LiveError{Code: "busy", Message: "busy"}, &liveError) {
		t.Fatal("live error mapping")
	}
}
