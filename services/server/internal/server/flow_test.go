package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// This integration test exercises real HTTP, dispatch handling and filesystem storage.
// PostgreSQL and the WebSocket wire are separate integration boundaries.
func TestRunFlowWaitsForReclaimedSlot(t *testing.T) {
	ctx := context.Background()
	store := newFlowStore()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(store, log)
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAPI(store, files, engine, "test-token", log).Handler(nil)
	request := func(method, path, body, attempt string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer test-token")
		if attempt != "" {
			r.Header.Set("X-Attempt-Id", attempt)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	create := func() Run {
		w := request("POST", "/api/tests/"+store.testID+"/runs", "", "")
		if w.Code != http.StatusAccepted {
			t.Fatalf("create: %d %s", w.Code, w.Body)
		}
		var run Run
		if err := json.Unmarshal(w.Body.Bytes(), &run); err != nil || run.Status != "queued" {
			t.Fatalf("unexpected Run: %+v, %v", run, err)
		}
		return run
	}
	first, second := create(), create()
	peer := &recordPeer{}
	session, err := engine.Attach(ctx, "manager-test", 1, peer)
	if err != nil {
		t.Fatal(err)
	}
	testHeartbeat(t, engine, session, nil)
	if err := engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if len(peer.messages) != 1 || peer.messages[0].RunID != first.ID {
		t.Fatalf("expected FIFO dispatch: %+v", peer.messages)
	}
	dispatch := peer.messages[0]
	var task struct {
		Kind      string `json:"kind"`
		Script    string `json:"script"`
		TimeoutMS int    `json:"timeoutMs"`
	}
	if err := json.Unmarshal(dispatch.Payload, &task); err != nil || task.Kind != "run" || task.Script == "" || task.TimeoutMS != 60000 {
		t.Fatalf("invalid dispatch payload: %+v, %v", task, err)
	}
	handle := func(kind string, payload any) {
		t.Helper()
		if err := engine.Handle(ctx, session, NewEnvelope(kind, "manager-test", first.ID, dispatch.AttemptID, payload)); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
	}
	handle("ack", struct{}{})
	if err := engine.Tick(ctx); err != nil || len(peer.messages) != 1 {
		t.Fatalf("ACK should stop dispatch retries: %v %+v", err, peer.messages)
	}
	event := Event{NewID(), "started", "worker started"}
	handle("event", event)
	handle("event", event)
	if store.eventCount != 1 {
		t.Fatal("duplicate event should not be persisted twice")
	}
	stale := NewEnvelope("result", "manager-test", first.ID, NewID(), Result{Status: "succeeded"})
	if err := engine.Handle(ctx, session, stale); err == nil {
		t.Fatal("stale attempt must not finish the current run")
	}
	for name, body := range map[string]string{"report.html": "<!doctype html><h1>passed</h1>", "results.json": `{"status":"passed"}`} {
		w := request("POST", "/api/manager/runs/"+first.ID+"/artifacts/"+name, body, dispatch.AttemptID)
		if w.Code != 200 {
			t.Fatalf("upload: %d %s", w.Code, w.Body)
		}
	}
	handle("result", Result{Status: "succeeded"})
	handle("result", Result{Status: "succeeded"})
	if err := engine.Tick(ctx); err != nil || len(peer.messages) != 1 {
		t.Fatalf("result must not release slot before cleanup heartbeat: %v", err)
	}
	w := request("GET", "/api/runs/"+first.ID, "", "")
	var completed Run
	if err := json.Unmarshal(w.Body.Bytes(), &completed); w.Code != 200 || err != nil || completed.Status != "succeeded" || completed.ReportURL == "" {
		t.Fatalf("result API: %d %s, %v", w.Code, w.Body, err)
	}
	w = request("GET", completed.ReportURL, "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "passed") || !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox allow-scripts;") {
		t.Fatalf("report unavailable or unsandboxed: %d %s", w.Code, w.Body)
	}
	handle("heartbeat", map[string]any{"active": []ActiveAttempt{}})
	if err := engine.Tick(ctx); err != nil || len(peer.messages) != 2 || peer.messages[1].RunID != second.ID {
		t.Fatalf("next FIFO task after cleanup: %v %+v", err, peer.messages)
	}
}

func TestReconnectPreservesAttemptAndCancellation(t *testing.T) {
	ctx := context.Background()
	store := newFlowStore()
	first, _ := store.CreateRun(ctx, store.testID)
	second, _ := store.CreateRun(ctx, store.testID)
	engine := NewEngine(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	peer1 := &recordPeer{}
	session1, err := engine.Attach(ctx, "manager-test", 1, peer1)
	if err != nil {
		t.Fatal(err)
	}
	testHeartbeat(t, engine, session1, nil)
	if err := engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	attempt := peer1.messages[0].AttemptID
	engine.Detach(session1)
	peer2 := &recordPeer{}
	session2, err := engine.Attach(ctx, "manager-test", 1, peer2)
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(ctx); err != nil || len(peer2.messages) != 0 {
		t.Fatal("reconnect must wait for reconciliation heartbeat")
	}
	hb := NewEnvelope("heartbeat", "manager-test", "", "", map[string]any{"active": []ActiveAttempt{{first.ID, attempt}}})
	if err := engine.Handle(ctx, session2, hb); err != nil {
		t.Fatal(err)
	}
	unknown := NewEnvelope("heartbeat", "manager-test", "", "", map[string]any{"active": []ActiveAttempt{{NewID(), NewID()}}})
	if err := engine.Handle(ctx, session2, unknown); err == nil {
		t.Fatal("unknown active attempt must be rejected")
	}
	if err := engine.Tick(ctx); err != nil || len(peer2.messages) != 0 {
		t.Fatal("unknown active attempt must pause dispatch immediately")
	}
	if err := engine.Handle(ctx, session2, hb); err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(ctx); err != nil || len(peer2.messages) != 0 || store.assigned[first.ID].AttemptID != attempt {
		t.Fatalf("active heartbeat must acknowledge the existing attempt without rerunning: %v %+v", err, peer2.messages)
	}
	if _, err := store.Cancel(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Cancel(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(ctx); err != nil || len(peer2.messages) != 1 || peer2.messages[0].Type != "cancel" || peer2.messages[0].AttemptID != attempt {
		t.Fatalf("active cancellation must target existing attempt: %v %+v", err, peer2.messages)
	}
	if store.runs[second.ID].Status != "cancelled" {
		t.Fatal("queued cancellation should finish without dispatch")
	}
}

func testHeartbeat(t *testing.T, engine *Engine, session *Session, active []ActiveAttempt) {
	t.Helper()
	if active == nil {
		active = []ActiveAttempt{}
	}
	if err := engine.Handle(context.Background(), session, NewEnvelope("heartbeat", "manager-test", "", "", map[string]any{"active": active})); err != nil {
		t.Fatal(err)
	}
}

type recordPeer struct {
	messages   []Envelope
	heartbeats []Envelope
}

func (p *recordPeer) Send(m Envelope) error {
	if m.Type == "heartbeat_ack" {
		p.heartbeats = append(p.heartbeats, m)
	} else {
		p.messages = append(p.messages, m)
	}
	return nil
}
func (p *recordPeer) Close() error { return nil }

// flowStore is a deterministic test double for the persistent boundary.
type flowStore struct {
	Store
	testID     string
	runs       map[string]Run
	queue      []string
	assigned   map[string]*Assignment
	artifacts  map[string]Artifact
	released   map[string]bool
	events     map[string]bool
	eventCount int
}

func newFlowStore() *flowStore {
	return &flowStore{testID: NewID(), runs: map[string]Run{}, assigned: map[string]*Assignment{}, artifacts: map[string]Artifact{}, released: map[string]bool{}, events: map[string]bool{}}
}

func (s *flowStore) CreateRun(_ context.Context, testID string) (Run, error) {
	r := Run{ID: NewID(), TestID: testID, Status: "queued", CreatedAt: time.Now().UTC()}
	s.runs[r.ID] = r
	s.queue = append(s.queue, r.ID)
	return r, nil
}

func (s *flowStore) Run(_ context.Context, id string) (Run, error) {
	r, ok := s.runs[id]
	if !ok {
		return r, ErrNotFound
	}
	return r, nil
}

func (s *flowStore) RegisterManager(context.Context, string, int) error { return nil }

func (s *flowStore) Assignments(_ context.Context, _ string) ([]Assignment, error) {
	items := []Assignment{}
	for _, id := range s.queue {
		if a := s.assigned[id]; a != nil && !s.released[id] {
			copy := *a
			copy.Status = s.runs[id].Status
			items = append(items, copy)
		}
	}
	return items, nil
}

func (s *flowStore) Claim(ctx context.Context, managerID string, capacity int) (*Assignment, error) {
	active, _ := s.Assignments(ctx, managerID)
	if len(active) >= capacity {
		return nil, nil
	}
	for _, id := range s.queue {
		r := s.runs[id]
		if r.Status == "queued" {
			r.Status = "dispatched"
			s.runs[id] = r
			a := &Assignment{Run: r, ManagerID: managerID, AttemptID: NewID(), Script: "test('seed', () => {});", TimeoutMS: 60000}
			s.assigned[id] = a
			return a, nil
		}
	}
	return nil, nil
}

func (s *flowStore) check(managerID, runID, attemptID string) error {
	a := s.assigned[runID]
	if a == nil || a.ManagerID != managerID || a.AttemptID != attemptID {
		return ErrConflict
	}
	return nil
}

func (s *flowStore) Acknowledge(_ context.Context, managerID, runID, attemptID string) error {
	if err := s.check(managerID, runID, attemptID); err != nil {
		return err
	}
	s.assigned[runID].Acked = true
	return nil
}

func (s *flowStore) AddEvent(_ context.Context, managerID, runID, attemptID string, event Event) error {
	if err := s.check(managerID, runID, attemptID); err != nil {
		return err
	}
	if !s.events[event.EventID] {
		s.events[event.EventID] = true
		s.eventCount++
	}
	r := s.runs[runID]
	if event.Kind == "started" {
		r.Status = "running"
		s.runs[runID] = r
	}
	return nil
}

func (s *flowStore) Complete(_ context.Context, managerID, runID, attemptID string, result Result) error {
	if err := s.check(managerID, runID, attemptID); err != nil {
		return err
	}
	r := s.runs[runID]
	r.Status, r.Error = result.Status, result.Error
	s.runs[runID] = r
	return nil
}

func (s *flowStore) ReleaseSlots(_ context.Context, _ string, active []ActiveAttempt) error {
	for id, r := range s.runs {
		retained := false
		for _, a := range active {
			if a.RunID == id {
				retained = true
			}
		}
		if Terminal(r.Status) && !retained {
			s.released[id] = true
		}
	}
	return nil
}

func (s *flowStore) UploadAllowed(_ context.Context, runID, attemptID, _ string) error {
	return s.check("manager-test", runID, attemptID)
}

func (s *flowStore) SaveArtifact(_ context.Context, a Artifact) error {
	s.artifacts[a.RunID+"/"+a.Name] = a
	if a.Name == "report.html" {
		r := s.runs[a.RunID]
		r.ReportURL = "/api/runs/" + a.RunID + "/artifacts/report.html"
		s.runs[a.RunID] = r
	}
	return nil
}

func (s *flowStore) Artifact(_ context.Context, runID, name string) (Artifact, error) {
	a, ok := s.artifacts[runID+"/"+name]
	if !ok {
		return a, ErrNotFound
	}
	return a, nil
}

func (s *flowStore) Cancel(_ context.Context, id string) (Run, error) {
	r := s.runs[id]
	if r.Status == "queued" {
		r.Status = "cancelled"
	} else if !Terminal(r.Status) {
		r.Status = "cancelling"
	}
	s.runs[id] = r
	return r, nil
}
