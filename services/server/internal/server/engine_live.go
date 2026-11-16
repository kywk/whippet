package server

import (
	"context"
	"fmt"
	"time"
)

func (e *Engine) SetLiveHub(hub *LiveHub) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.liveHub = hub
}

func (e *Engine) LiveManagerEpoch(managerID string) (string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session == nil || !e.session.ready || e.session.managerID != managerID {
		return "", false
	}
	return e.session.liveEpoch, true
}

func (e *Engine) QueueLiveCommand(command LiveCommand) error {
	select {
	case e.liveCommands <- command:
		return nil
	default:
		return fmt.Errorf("live control queue full")
	}
}

func (e *Engine) sendLiveCommand(ctx context.Context, command LiveCommand) error {
	if command.SessionTarget != nil {
		return e.sendSessionLiveCommand(ctx, command)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.session
	if s == nil || !s.ready || s.managerID != command.Target.ManagerID || s.liveEpoch != command.ManagerEpoch ||
		!ValidID(command.ViewerID) || (command.Type != "live.start" && command.Type != "live.stop") {
		return fmt.Errorf("live Manager session unavailable")
	}
	target, err := e.store.LiveTarget(ctx, command.Target.RunID)
	if err != nil || target.ManagerID != s.managerID || target.AttemptID != command.Target.AttemptID ||
		(command.Type == "live.start" && !target.active()) {
		return fmt.Errorf("live attempt binding unavailable")
	}
	payload := struct {
		ViewerID   string       `json:"viewerId"`
		ICEServers *[]ICEServer `json:"iceServers,omitempty"`
	}{ViewerID: command.ViewerID}
	if command.Type == "live.start" {
		payload.ICEServers = &command.ICEServers
	}
	// Only short control messages use this writer. Media bytes never enter Engine.
	// A live failure does not change Run status or independently reset control state.
	return s.peer.Send(NewEnvelope(command.Type, s.managerID, target.RunID, target.AttemptID, payload))
}

func (e *Engine) sendSessionLiveCommand(ctx context.Context, command LiveCommand) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.session
	target := command.SessionTarget
	if s == nil || !s.ready || target == nil || s.managerID != target.ManagerID || s.liveEpoch != command.ManagerEpoch ||
		!ValidID(command.ViewerID) || (command.Type != "session.live.start" && command.Type != "session.live.stop") {
		return fmt.Errorf("live Manager session unavailable")
	}
	p, ok := e.store.(*Postgres)
	if !ok {
		return fmt.Errorf("browser session unavailable")
	}
	if command.Type == "session.live.start" {
		current, err := p.BrowserSessionLiveTarget(ctx, target.SessionID, target.LeaseID)
		if err != nil || current.ManagerID != s.managerID || current.ManagerEpoch != s.liveEpoch {
			return fmt.Errorf("browser session live binding unavailable")
		}
	} else {
		current, err := p.BrowserLeaseBySession(ctx, target.SessionID)
		if err != nil || current.LeaseID != target.LeaseID || current.ManagerID != s.managerID || current.ManagerEpoch != s.liveEpoch {
			return fmt.Errorf("browser session live binding unavailable")
		}
	}
	payload := struct {
		SessionID string       `json:"sessionId"`
		LeaseID   string       `json:"leaseId"`
		ViewerID  string       `json:"viewerId"`
		ICE       *[]ICEServer `json:"iceServers,omitempty"`
	}{SessionID: target.SessionID, LeaseID: target.LeaseID, ViewerID: command.ViewerID}
	if command.Type == "session.live.start" {
		payload.ICE = &command.ICEServers
	}
	return s.peer.Send(NewEnvelope(command.Type, s.managerID, "", "", payload))
}

func (e *Engine) endLiveBrowserSession(sessionID string) {
	e.mu.Lock()
	hub := e.liveHub
	e.mu.Unlock()
	if hub != nil {
		hub.EndBrowserSession(sessionID)
	}
}

func (e *Engine) refreshLive(ctx context.Context) {
	e.mu.Lock()
	hub := e.liveHub
	e.mu.Unlock()
	if hub != nil {
		hub.Sweep(ctx, time.Now())
	}
}

func (e *Engine) endLiveRun(runID string) {
	e.mu.Lock()
	hub := e.liveHub
	e.mu.Unlock()
	if hub != nil {
		hub.EndRun(runID)
	}
}
