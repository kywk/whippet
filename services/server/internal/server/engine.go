package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
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
	liveEpoch string
	capacity  int
	peer      Peer
	ready     bool
	sent      map[string]time.Time
	siteAI    siteAIConnectionView
}

type Engine struct {
	store             Store
	log               *slog.Logger
	mu                sync.Mutex
	session           *Session
	wake              chan struct{}
	liveCommands      chan LiveCommand
	liveHub           *LiveHub
	browserCalls      map[string]*browserCallFlight
	browserCacheBytes int
}

func NewEngine(store Store, log *slog.Logger) *Engine {
	return &Engine{store: store, log: log, wake: make(chan struct{}, 1), liveCommands: make(chan LiveCommand, 32), browserCalls: map[string]*browserCallFlight{}}
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
		case command := <-e.liveCommands:
			commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := e.sendLiveCommand(commandCtx, command)
			cancel()
			if err != nil && command.OnError != nil {
				command.OnError(err)
			}
			continue
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
	return e.AttachSiteAI(ctx, managerID, capacity, peer, nil, false)
}

func (e *Engine) AttachSiteAI(ctx context.Context, managerID string, capacity int, peer Peer, caps *SiteAIManagerCapabilities, secure bool) (*Session, error) {
	if len(managerID) == 0 || len(managerID) > 128 || capacity < 1 || capacity > 64 {
		return nil, fmt.Errorf("%w: hello requires managerId and positive capacity", ErrInvalid)
	}
	e.mu.Lock()
	var previous *Session
	defer func() {
		hub := e.liveHub
		e.mu.Unlock()
		if hub != nil && previous != nil {
			hub.ManagerLost(previous.managerID, previous.liveEpoch)
		}
	}()
	if err := e.store.RegisterManager(ctx, managerID, capacity); err != nil {
		return nil, err
	}
	if e.session != nil {
		previous = e.session
		_ = e.session.peer.Close()
	}
	conn, err := newSiteAIConnection(managerID, caps, secure)
	if err != nil {
		return nil, err
	}
	if p, ok := e.store.(*Postgres); ok {
		p.siteAIConn.Store(nil)
		if err := p.reconcileSiteAIProvisions(ctx, managerID, conn.Epoch); err != nil {
			return nil, err
		}
		if err := p.MarkBrowserLeaseReclaimPending(ctx, managerID); err != nil {
			return nil, err
		}
		e.failBrowserCallsLocked("unknown_result")
	}
	// Even a fresh DB must reconcile the Manager's active journal before dispatch.
	s := &Session{managerID: managerID, liveEpoch: conn.Epoch, capacity: capacity, peer: peer, sent: map[string]time.Time{}, siteAI: conn}
	e.session = s
	e.Wake()
	return s, nil
}

func (e *Engine) Detach(s *Session) {
	e.mu.Lock()
	hub := e.liveHub
	if e.session == s {
		e.session = nil
		if p, ok := e.store.(*Postgres); ok {
			p.siteAIConn.Store(nil)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = p.MarkBrowserLeaseReclaimPending(ctx, s.managerID)
			cancel()
			e.failBrowserCallsLocked("unknown_result")
		}
	}
	_ = s.peer.Close()
	e.mu.Unlock()
	if hub != nil {
		hub.ManagerLost(s.managerID, s.liveEpoch)
	}
}

func (e *Engine) Close() {
	e.mu.Lock()
	hub, previous := e.liveHub, e.session
	if e.session != nil {
		_ = e.session.peer.Close()
		e.session = nil
		if p, ok := e.store.(*Postgres); ok {
			p.siteAIConn.Store(nil)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = p.MarkBrowserLeaseReclaimPending(ctx, previous.managerID)
			cancel()
			e.failBrowserCallsLocked("unknown_result")
		}
	}
	e.mu.Unlock()
	if hub != nil && previous != nil {
		hub.ManagerLost(previous.managerID, previous.liveEpoch)
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
	endedRun := ""
	defer func() {
		hub := e.liveHub
		e.mu.Unlock()
		if hub != nil && endedRun != "" {
			hub.EndRun(endedRun)
		}
	}()
	if e.session != s || m.ManagerID != s.managerID {
		return ErrConflict
	}
	if m.Type == "heartbeat" {
		var payload struct {
			Active   *[]ActiveAttempt `json:"active"`
			Admin    json.RawMessage  `json:"admin"`
			Sessions []struct {
				SessionID string `json:"sessionId"`
				LeaseID   string `json:"leaseId"`
				State     string `json:"state"`
			} `json:"sessions"`
		}
		if err := json.Unmarshal(m.Payload, &payload); err != nil || payload.Active == nil {
			return fmt.Errorf("%w: heartbeat requires active array", ErrInvalid)
		}
		var admin siteAIManagerHeartbeat
		if s.siteAI.Capabilities != nil {
			var err error
			admin, err = parseSiteAIManagerHeartbeat(payload.Admin, s.capacity)
			if err != nil {
				return err
			}
		} else if len(payload.Admin) != 0 {
			return ErrInvalid
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
		reportedOccupancy := len(*payload.Active)
		if p, ok := e.store.(*Postgres); ok {
			provisionCount, err := p.checkSiteAIProvisionHeartbeat(ctx, s, admin.ActiveProvisionIDs)
			if err != nil {
				return err
			}
			reportedOccupancy += provisionCount
			reportedLeases := make(map[string]bool, len(payload.Sessions))
			for _, reported := range payload.Sessions {
				if !ValidID(reported.SessionID) || !ValidID(reported.LeaseID) ||
					(reported.State != "starting" && reported.State != "ready" && reported.State != "closing" && reported.State != "reclaim_pending") {
					return ErrInvalid
				}
				lease, err := p.BrowserLeaseBySession(ctx, reported.SessionID)
				if err == nil && lease.LeaseID == reported.LeaseID && lease.ManagerID == s.managerID && !lease.Reclaimed && !reportedLeases[reported.SessionID] {
					reportedLeases[reported.SessionID] = true
					reportedOccupancy++
				}
				if err != nil || lease.LeaseID != reported.LeaseID || lease.ManagerID != s.managerID || lease.Reclaimed || lease.ManagerEpoch != s.liveEpoch || lease.State == "closing" || lease.State == "reclaim_pending" {
					if err := s.peer.Send(NewEnvelope("session.close", s.managerID, "", "", map[string]string{"sessionId": reported.SessionID, "leaseId": reported.LeaseID})); err != nil {
						s.ready = false
						return err
					}
				}
			}
			if _, err := p.DB.ExecContext(ctx, `UPDATE managers SET last_heartbeat_at=now() WHERE id=$1`, s.managerID); err != nil {
				return err
			}
		}
		if err := s.peer.Send(NewEnvelope("heartbeat_ack", s.managerID, "", "", s.siteAI.acknowledgement())); err != nil {
			s.ready = false
			_ = s.peer.Close()
			return err
		}
		s.ready = true
		s.siteAI.LastHeartbeat, s.siteAI.FreeSlots = time.Now().UTC(), admin.FreeSlots
		s.siteAI.ReportedOccupancy = reportedOccupancy
		if p, ok := e.store.(*Postgres); ok {
			view := s.siteAI
			p.siteAIConn.Store(&view)
		}
		e.Wake()
		return nil
	}
	if m.Type == "agent.provision_result" {
		p, ok := e.store.(*Postgres)
		var report siteAIProvisionResult
		if !ok || s.siteAI.Nonce == "" || !s.ready || m.RunID != "" || m.AttemptID != "" || decodeSiteAIJSON(m.Payload, &report) != nil {
			return ErrInvalid
		}
		if err := p.finishSiteAIProvision(ctx, s.siteAI, report); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		e.Wake()
		return nil
	}
	if strings.HasPrefix(m.Type, "session.") {
		return e.handleBrowserMessageLocked(ctx, s, m)
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
		if json.Unmarshal(m.Payload, &event) != nil || event.EventID == "" || event.EventID == archiveProgressEventID || len(event.EventID) > 128 ||
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
		if err == nil {
			endedRun = m.RunID
		}
	default:
		return fmt.Errorf("%w: unsupported manager message type", ErrInvalid)
	}
	if err == nil {
		e.Wake()
	}
	return err
}

func (e *Engine) Tick(ctx context.Context) error {
	if p, ok := e.store.(*Postgres); ok {
		if err := p.ExpireBrowserLeases(ctx); err != nil {
			return err
		}
		if err := p.ExpireExternalClaims(ctx); err != nil {
			return err
		}
		if err := p.expireSiteAIProvisions(ctx); err != nil {
			return err
		}
		if err := p.finalizeSiteAIManager(ctx); err != nil {
			return err
		}
		if err := p.finalizeWorkspaceArchives(ctx); err != nil {
			return err
		}
	}
	if finisher, ok := e.store.(interface{ FinalizeDiscardingSessions(context.Context) error }); ok {
		if err := finisher.FinalizeDiscardingSessions(ctx); err != nil {
			return err
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.session
	if s == nil || !s.ready {
		return nil
	}
	if err := e.sendBrowserClosesLocked(ctx, s); err != nil {
		return err
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
	if p, ok := e.store.(*Postgres); ok {
		if err := p.sendSiteAIProvisions(ctx, s, liveCommands); err != nil {
			return err
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
			replayAllowed := true
			if policy, ok := e.store.(interface{ CanDispatch(Assignment) bool }); ok {
				replayAllowed = policy.CanDispatch(a)
			}
			if !a.Acked && replayAllowed {
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
		if a.modelCredential != nil && (a.Author == nil || a.Author.Runtime == nil || !s.siteAI.supports(a.Author.Runtime.Engine)) {
			return nil
		}
		taskKind := "run"
		if a.Kind == "author" {
			taskKind = "author"
		}
		payload = struct {
			ScriptOrigin      string                 `json:"scriptOrigin"`
			WorkspaceID       string                 `json:"workspaceId"`
			TestID            *string                `json:"testId"`
			WorkspaceContext  *WorkspaceContext      `json:"workspaceContext,omitempty"`
			Kind              string                 `json:"kind"`
			Script            string                 `json:"script"`
			Files             []RunFile              `json:"files,omitempty"`
			ModuleABI         *ModuleABI             `json:"moduleAbi,omitempty"`
			Retest            *retestTarget          `json:"retest,omitempty"`
			TimeoutMS         int                    `json:"timeoutMs"`
			Author            *AuthorInput           `json:"author,omitempty"`
			WorkspaceSettings *WorkspaceSettings     `json:"workspaceSettings,omitempty"`
			ModelCredential   *siteAIModelCredential `json:"modelCredential,omitempty"`
		}{effectiveScriptOrigin(a.ScriptOrigin), a.WorkspaceID, a.TestID, a.WorkspaceContext, taskKind, a.Script, a.Files, a.ModuleABI, a.Retest, a.TimeoutMS, a.Author, a.WorkspaceSettings, a.modelCredential}
	}
	if err := s.peer.Send(NewEnvelope(kind, s.managerID, a.ID, a.AttemptID, payload)); err != nil {
		// The committed attempt is preserved, including when the write outcome is unknown.
		s.ready = false
		if p, ok := e.store.(*Postgres); ok {
			p.siteAIConn.Store(nil)
		}
		_ = s.peer.Close()
		return err
	}
	s.sent[key] = time.Now()
	return nil
}
