package server

import (
	"context"
	"fmt"
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

func (e *Engine) endLiveRun(runID string) {
	e.mu.Lock()
	hub := e.liveHub
	e.mu.Unlock()
	if hub != nil {
		hub.EndRun(runID)
	}
}
