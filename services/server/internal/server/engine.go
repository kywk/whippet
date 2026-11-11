package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Peer has a single writer: Engine serializes dispatch/cancel writes.
type Peer interface {
	Send(Envelope) error
	Close() error
}

type Session struct {
	managerID string
	capacity  int
	peer      Peer
	ready     bool
	sent      map[string]time.Time
}

type Engine struct {
	store   Store
	log     *slog.Logger
	mu      sync.Mutex
	session *Session
	wake    chan struct{}
}

func NewEngine(store Store, log *slog.Logger) *Engine {
	return &Engine{store: store, log: log, wake: make(chan struct{}, 1)}
}

func (e *Engine) Wake() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

func (e *Engine) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer e.Close()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-e.wake:
		}
		stepCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		if err := e.Tick(stepCtx); err != nil && ctx.Err() == nil {
			e.log.Error("manager dispatch", "error", err)
		}
		cancel()
	}
}

func (e *Engine) Attach(ctx context.Context, managerID string, capacity int, peer Peer) (*Session, error) {
	if len(managerID) == 0 || len(managerID) > 128 || capacity < 1 {
		return nil, fmt.Errorf("%w: hello requires managerId and positive capacity", ErrInvalid)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.store.RegisterManager(ctx, managerID, capacity); err != nil {
		return nil, err
	}
	if e.session != nil {
		_ = e.session.peer.Close()
	}
	// Even a fresh DB must reconcile the Manager's active journal before dispatch.
	s := &Session{managerID: managerID, capacity: capacity, peer: peer, sent: map[string]time.Time{}}
	e.session = s
	e.Wake()
	return s, nil
}

func (e *Engine) Detach(s *Session) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session == s {
		e.session = nil
	}
	_ = s.peer.Close()
}

func (e *Engine) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session != nil {
		_ = e.session.peer.Close()
		e.session = nil
	}
}

func ValidateEnvelope(m Envelope) error {
	if m.ProtocolVersion != 1 || m.MessageID == "" || len(m.MessageID) > 128 || m.ManagerID == "" || len(m.ManagerID) > 128 {
		return fmt.Errorf("%w: invalid protocolVersion, messageId or managerId", ErrInvalid)
	}
	return nil
}

func (e *Engine) Handle(ctx context.Context, s *Session, m Envelope) error {
	if err := ValidateEnvelope(m); err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session != s || m.ManagerID != s.managerID {
		return ErrConflict
	}
	if m.Type == "heartbeat" {
		var payload struct {
			Active *[]ActiveAttempt `json:"active"`
		}
		if err := json.Unmarshal(m.Payload, &payload); err != nil || payload.Active == nil {
			return fmt.Errorf("%w: heartbeat requires active array", ErrInvalid)
		}
		known, err := e.store.Assignments(ctx, s.managerID)
		if err != nil {
			return err
		}
		index := make(map[ActiveAttempt]Assignment, len(known))
		for _, a := range known {
			index[ActiveAttempt{a.ID, a.AttemptID}] = a
		}
		seen := map[ActiveAttempt]bool{}
		for _, a := range *payload.Active {
			if _, exists := index[a]; !exists || seen[a] {
				s.ready = false
				return fmt.Errorf("%w: unknown or repeated active attempt; dispatch paused", ErrConflict)
			}
			seen[a] = true
		}
		for _, a := range *payload.Active {
			// An active journal entry proves receipt even if the original ACK was lost.
			if !index[a].Acked {
				if err := e.store.Acknowledge(ctx, s.managerID, a.RunID, a.AttemptID); err != nil {
					s.ready = false
					return err
				}
			}
		}
		if err := e.store.ReleaseSlots(ctx, s.managerID, *payload.Active); err != nil {
			return err
		}
		if err := s.peer.Send(NewEnvelope("heartbeat_ack", s.managerID, "", "", struct{}{})); err != nil {
			s.ready = false
			_ = s.peer.Close()
			return err
		}
		s.ready = true
		e.Wake()
		return nil
	}
	if !ValidID(m.RunID) || !ValidID(m.AttemptID) {
		return fmt.Errorf("%w: runId and attemptId must be UUIDs", ErrInvalid)
	}
	var err error
	switch m.Type {
	case "ack":
		err = e.store.Acknowledge(ctx, s.managerID, m.RunID, m.AttemptID)
	case "event":
		var event Event
		if json.Unmarshal(m.Payload, &event) != nil || event.EventID == "" || len(event.EventID) > 128 ||
			(event.Kind != "started" && event.Kind != "log") || len(event.Message) > 64*1024 {
			return fmt.Errorf("%w: invalid event", ErrInvalid)
		}
		err = e.store.AddEvent(ctx, s.managerID, m.RunID, m.AttemptID, event)
	case "result":
		var result Result
		if json.Unmarshal(m.Payload, &result) != nil || !result.Valid() || len(result.Error) > 64*1024 {
			return fmt.Errorf("%w: invalid result", ErrInvalid)
		}
		err = e.store.Complete(ctx, s.managerID, m.RunID, m.AttemptID, result)
	default:
		return fmt.Errorf("%w: unsupported manager message type", ErrInvalid)
	}
	if err == nil {
		e.Wake()
	}
	return err
}

func (e *Engine) Tick(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.session
	if s == nil || !s.ready {
		return nil
	}
	assignments, err := e.store.Assignments(ctx, s.managerID)
	if err != nil {
		return err
	}
	liveCommands := make(map[string]bool, len(assignments))
	for _, a := range assignments {
		if a.Status == "cancelling" {
			liveCommands["cancel:"+a.AttemptID] = true
			if !a.Acked {
				liveCommands["dispatch:"+a.AttemptID] = true
			}
		} else if a.Status == "dispatched" && !a.Acked {
			liveCommands["dispatch:"+a.AttemptID] = true
		}
	}
	for key := range s.sent {
		if !liveCommands[key] {
			delete(s.sent, key)
		}
	}
	for _, a := range assignments {
		switch {
		case a.Status == "cancelling":
			// A lost dispatch must not leave an unknown cancel permanently occupying a slot.
			if !a.Acked {
				if err := e.send(s, a, "dispatch"); err != nil {
					return err
				}
			}
			if err := e.send(s, a, "cancel"); err != nil {
				return err
			}
		case a.Status == "dispatched" && !a.Acked:
			if err := e.send(s, a, "dispatch"); err != nil {
				return err
			}
		}
	}
	for i := 0; i < s.capacity; i++ {
		a, err := e.store.Claim(ctx, s.managerID, s.capacity)
		if err != nil || a == nil {
			return err
		}
		if err := e.send(s, *a, "dispatch"); err != nil {
			return err
		}
	}
	return nil
}

func (e *Engine) send(s *Session, a Assignment, kind string) error {
	key := kind + ":" + a.AttemptID
	if time.Since(s.sent[key]) < 5*time.Second {
		return nil
	}
	var payload any = struct{}{}
	if kind == "dispatch" {
		taskKind := "run"
		if a.Kind == "author" {
			taskKind = "author"
		}
		payload = struct {
			Kind      string       `json:"kind"`
			Script    string       `json:"script"`
			TimeoutMS int          `json:"timeoutMs"`
			Author    *AuthorInput `json:"author,omitempty"`
		}{taskKind, a.Script, a.TimeoutMS, a.Author}
	}
	if err := s.peer.Send(NewEnvelope(kind, s.managerID, a.ID, a.AttemptID, payload)); err != nil {
		// The committed attempt is preserved, including when the write outcome is unknown.
		s.ready = false
		_ = s.peer.Close()
		return err
	}
	s.sent[key] = time.Now()
	return nil
}
