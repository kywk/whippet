package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
)

func TestFIFOAndCapacityHoldUntilCleanup(t *testing.T) {
	ctx := context.Background()
	store := newFlowStore()
	first, _ := store.CreateRun(ctx, store.testID)
	second, _ := store.CreateRun(ctx, store.testID)
	third, _ := store.CreateRun(ctx, store.testID)
	peer := &recordPeer{}
	engine := NewEngine(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	session, err := engine.Attach(ctx, "manager-test", 2, peer)
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(ctx); err != nil || len(peer.messages) != 0 {
		t.Fatal("new session dispatched before its first heartbeat")
	}
	testHeartbeat(t, engine, session, nil)
	ack := peer.heartbeats[0]
	if ack.Type != "heartbeat_ack" || ack.RunID != "" || ack.AttemptID != "" || string(ack.Payload) != "{}" {
		t.Fatalf("invalid heartbeat ACK: %+v", ack)
	}
	if err := engine.Tick(ctx); err != nil || len(peer.messages) != 2 || peer.messages[0].RunID != first.ID || peer.messages[1].RunID != second.ID {
		t.Fatalf("FIFO capacity 2: %v %+v", err, peer.messages)
	}
	attempt1, attempt2 := peer.messages[0].AttemptID, peer.messages[1].AttemptID
	testHeartbeat(t, engine, session, []ActiveAttempt{{first.ID, attempt1}, {second.ID, attempt2}})
	if err := engine.Handle(ctx, session, NewEnvelope("result", "manager-test", first.ID, attempt1, Result{Status: "failed"})); err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(ctx); err != nil || len(peer.messages) != 2 {
		t.Fatal("terminal result released capacity before cleanup heartbeat")
	}
	testHeartbeat(t, engine, session, []ActiveAttempt{{second.ID, attempt2}})
	if err := engine.Tick(ctx); err != nil || len(peer.messages) != 3 || peer.messages[2].RunID != third.ID {
		t.Fatalf("third task did not wait for reclamation: %v %+v", err, peer.messages)
	}
}

type failingPeer struct {
	recordPeer
	failKind string
}

func (p *failingPeer) Send(m Envelope) error {
	if m.Type == p.failKind {
		return errors.New("simulated connection loss")
	}
	return p.recordPeer.Send(m)
}

func TestLostDispatchThenCancellationKeepsSameAttempt(t *testing.T) {
	ctx := context.Background()
	store := newFlowStore()
	run, _ := store.CreateRun(ctx, store.testID)
	engine := NewEngine(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	broken := &failingPeer{failKind: "dispatch"}
	session, err := engine.Attach(ctx, "manager-test", 1, broken)
	if err != nil {
		t.Fatal(err)
	}
	testHeartbeat(t, engine, session, nil)
	if err := engine.Tick(ctx); err == nil {
		t.Fatal("dispatch should fail while preserving its committed attempt")
	}
	attempt := store.assigned[run.ID].AttemptID
	if _, err := store.Cancel(ctx, run.ID); err != nil {
		t.Fatal(err)
	}
	engine.Detach(session)
	peer := &recordPeer{}
	reconnected, err := engine.Attach(ctx, "manager-test", 1, peer)
	if err != nil {
		t.Fatal(err)
	}
	testHeartbeat(t, engine, reconnected, nil)
	if err := engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if len(peer.messages) != 2 || peer.messages[0].Type != "dispatch" || peer.messages[1].Type != "cancel" ||
		peer.messages[0].AttemptID != attempt || peer.messages[1].AttemptID != attempt || len(store.assigned) != 1 {
		t.Fatalf("unknown cancel must follow the original attempt dispatch: %+v", peer.messages)
	}
}

func TestHeartbeatAckFailurePausesDispatch(t *testing.T) {
	store := newFlowStore()
	_, _ = store.CreateRun(context.Background(), store.testID)
	engine := NewEngine(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	peer := &failingPeer{failKind: "heartbeat_ack"}
	session, err := engine.Attach(context.Background(), "manager-test", 1, peer)
	if err != nil {
		t.Fatal(err)
	}
	heartbeat := NewEnvelope("heartbeat", "manager-test", "", "", map[string]any{"active": []ActiveAttempt{}})
	if err := engine.Handle(context.Background(), session, heartbeat); err == nil {
		t.Fatal("heartbeat ACK failure was swallowed")
	}
	if err := engine.Tick(context.Background()); err != nil || len(store.assigned) != 0 {
		t.Fatal("failed heartbeat ACK must prevent new assignments")
	}
}
