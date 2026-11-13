package server

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

type browserCallFlight struct {
	done      chan struct{}
	result    json.RawMessage
	code      string
	complete  bool
	createdAt time.Time
}

func browserCallKey(sessionID, callID string) string { return sessionID + ":" + callID }

func (e *Engine) BrowserEndpoint() (string, string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session == nil || !e.session.ready {
		return "", "", false
	}
	return e.session.managerID, e.session.liveEpoch, true
}

func (e *Engine) SendBrowserOpen(lease BrowserLease) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.session
	if s == nil || !s.ready || s.managerID != lease.ManagerID || s.liveEpoch != lease.ManagerEpoch {
		return ErrConflict
	}
	payload := struct {
		SessionID           string          `json:"sessionId"`
		LeaseID             string          `json:"leaseId"`
		WorkspaceID         string          `json:"workspaceId"`
		WorkspaceContext    json.RawMessage `json:"workspaceContext"`
		AllowedTools        []string        `json:"allowedTools"`
		ToolRegistryVersion string          `json:"toolRegistryVersion"`
		ToolRegistrySHA256  string          `json:"toolRegistrySha256"`
		IdleTimeoutMS       int             `json:"idleTimeoutMs"`
		MaxLifetimeMS       int             `json:"maxLifetimeMs"`
	}{lease.SessionID, lease.LeaseID, lease.WorkspaceID, lease.WorkspaceContext, browserAllowedTools,
		lease.RegistryVersion, lease.RegistrySHA256, browserIdleTimeoutMS, browserMaxLifetimeMS}
	if err := s.peer.Send(NewEnvelope("session.open", s.managerID, "", "", payload)); err != nil {
		s.ready = false
		_ = s.peer.Close()
		return err
	}
	return nil
}

func (e *Engine) SendBrowserCall(lease BrowserLease, callID, name string, args json.RawMessage) (*browserCallFlight, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.session
	if s == nil || !s.ready || s.managerID != lease.ManagerID || s.liveEpoch != lease.ManagerEpoch {
		return nil, ErrConflict
	}
	if len(e.browserCalls) >= 256 {
		e.evictBrowserCallLocked()
		if len(e.browserCalls) >= 256 {
			return nil, ErrConflict
		}
	}
	key := browserCallKey(lease.SessionID, callID)
	if _, exists := e.browserCalls[key]; exists {
		return nil, ErrConflict
	}
	flight := &browserCallFlight{done: make(chan struct{}), createdAt: time.Now()}
	e.browserCalls[key] = flight
	payload := struct {
		SessionID string          `json:"sessionId"`
		LeaseID   string          `json:"leaseId"`
		CallID    string          `json:"callId"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}{lease.SessionID, lease.LeaseID, callID, name, args}
	if err := s.peer.Send(NewEnvelope("session.call", s.managerID, "", "", payload)); err != nil {
		s.ready = false
		_ = s.peer.Close()
		flight.code, flight.complete = "unknown_result", true
		close(flight.done)
		return nil, err
	}
	return flight, nil
}

func (e *Engine) BrowserCachedCall(sessionID, callID string) (json.RawMessage, string, bool, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	flight := e.browserCalls[browserCallKey(sessionID, callID)]
	if flight == nil {
		return nil, "", false, false
	}
	if !flight.complete {
		return nil, "busy", true, false
	}
	return append(json.RawMessage(nil), flight.result...), flight.code, true, true
}

func (e *Engine) AwaitBrowserCall(ctx context.Context, flight *browserCallFlight) (json.RawMessage, string) {
	select {
	case <-ctx.Done():
		return nil, "unknown_result"
	case <-flight.done:
		e.mu.Lock()
		defer e.mu.Unlock()
		return append(json.RawMessage(nil), flight.result...), flight.code
	}
}

func (e *Engine) failBrowserCallsLocked(code string) {
	for _, flight := range e.browserCalls {
		if !flight.complete {
			flight.complete, flight.code = true, code
			close(flight.done)
		}
	}
}

func (e *Engine) evictBrowserCallLocked() {
	var oldestKey string
	var oldest time.Time
	for key, flight := range e.browserCalls {
		if flight.complete && (oldestKey == "" || flight.createdAt.Before(oldest)) {
			oldestKey, oldest = key, flight.createdAt
		}
	}
	if oldestKey != "" {
		e.browserCacheBytes -= len(e.browserCalls[oldestKey].result)
		delete(e.browserCalls, oldestKey)
	}
}

func (e *Engine) sendBrowserClosesLocked(ctx context.Context, s *Session) error {
	p, ok := e.store.(*Postgres)
	if !ok {
		return nil
	}
	leases, err := p.BrowserLeasesToClose(ctx, s.managerID)
	if err != nil {
		return err
	}
	for _, lease := range leases {
		if err := s.peer.Send(NewEnvelope("session.close", s.managerID, "", "", map[string]string{"sessionId": lease.SessionID, "leaseId": lease.LeaseID})); err != nil {
			s.ready = false
			_ = s.peer.Close()
			return err
		}
		if err := p.MarkBrowserCloseSent(ctx, lease.SessionID); err != nil {
			return err
		}
	}
	return nil
}

func strictBrowserPayload(raw []byte, fields ...string) (map[string]json.RawMessage, error) {
	if len(raw) > 256<<10 || strictJSONNoDuplicates(raw) != nil {
		return nil, ErrInvalid
	}
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil || len(values) != len(fields) {
		return nil, ErrInvalid
	}
	for _, field := range fields {
		if _, ok := values[field]; !ok {
			return nil, ErrInvalid
		}
	}
	return values, nil
}

func (e *Engine) handleBrowserMessageLocked(ctx context.Context, s *Session, m Envelope) error {
	if m.RunID != "" || m.AttemptID != "" {
		return ErrInvalid
	}
	p, ok := e.store.(*Postgres)
	if !ok {
		return ErrInvalid
	}
	switch m.Type {
	case "session.ready", "session.open_rejected", "session.closed":
		fields := []string{"sessionId", "leaseId"}
		if m.Type == "session.open_rejected" {
			fields = append(fields, "error")
		}
		if m.Type == "session.closed" {
			fields = append(fields, "reason", "reclaimed")
		}
		if _, err := strictBrowserPayload(m.Payload, fields...); err != nil {
			return err
		}
		var event struct {
			SessionID string `json:"sessionId"`
			LeaseID   string `json:"leaseId"`
			Error     string `json:"error"`
			Reason    string `json:"reason"`
			Reclaimed bool   `json:"reclaimed"`
		}
		if json.Unmarshal(m.Payload, &event) != nil || !ValidID(event.SessionID) || !ValidID(event.LeaseID) {
			return ErrInvalid
		}
		switch m.Type {
		case "session.ready":
			return p.BrowserReady(ctx, s.managerID, s.liveEpoch, event.SessionID, event.LeaseID)
		case "session.open_rejected":
			if event.Error != "capacity_full" && event.Error != "invalid_request" && event.Error != "session_unavailable" {
				return ErrInvalid
			}
			return p.BrowserOpenRejected(ctx, s.managerID, s.liveEpoch, event.SessionID, event.LeaseID)
		default:
			if event.Reason != "closed" && event.Reason != "idle_timeout" && event.Reason != "lifetime_timeout" && event.Reason != "cancelled" && event.Reason != "worker_failed" && event.Reason != "manager_restart" {
				return ErrInvalid
			}
			if err := p.BrowserClosed(ctx, s.managerID, event.SessionID, event.LeaseID, event.Reclaimed); err != nil {
				return err
			}
			if event.Reclaimed {
				e.failBrowserLeaseCallsLocked(event.SessionID, "unknown_result")
			}
			return nil
		}
	case "session.reply":
		values, err := strictBrowserPayload(m.Payload, "sessionId", "leaseId", "callId", "result")
		if err != nil {
			values, err = strictBrowserPayload(m.Payload, "sessionId", "leaseId", "callId", "error")
			if err != nil {
				return ErrInvalid
			}
		}
		var sessionID, leaseID, callID, code string
		if json.Unmarshal(values["sessionId"], &sessionID) != nil || json.Unmarshal(values["leaseId"], &leaseID) != nil || json.Unmarshal(values["callId"], &callID) != nil || !ValidID(sessionID) || !ValidID(leaseID) || !ValidID(callID) {
			return ErrInvalid
		}
		if raw, ok := values["error"]; ok {
			if json.Unmarshal(raw, &code) != nil || !validBrowserError(code) {
				return ErrInvalid
			}
		}
		lease, err := p.BrowserLeaseBySession(ctx, sessionID)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if lease.LeaseID != leaseID || lease.ManagerID != s.managerID || lease.ManagerEpoch != s.liveEpoch || lease.State != "ready" {
			return nil
		}
		flight := e.browserCalls[browserCallKey(sessionID, callID)]
		if flight == nil || flight.complete {
			return nil
		}
		result := append(json.RawMessage(nil), values["result"]...)
		if len(result) > 131072 {
			result, code = nil, "unknown_result"
		}
		for e.browserCacheBytes+len(result) > 2<<20 {
			before := len(e.browserCalls)
			e.evictBrowserCallLocked()
			if len(e.browserCalls) == before {
				result, code = nil, "unknown_result"
				break
			}
		}
		if err := p.CompleteBrowserCall(ctx, sessionID, callID, code); err != nil {
			return err
		}
		flight.result, flight.code, flight.complete = result, code, true
		e.browserCacheBytes += len(result)
		close(flight.done)
		return nil
	default:
		return ErrInvalid
	}
}

func validBrowserError(code string) bool {
	switch code {
	case "session_unavailable", "tool_unavailable", "invalid_request", "busy", "unknown_result", "cancelled", "timeout":
		return true
	}
	return false
}

func (e *Engine) failBrowserLeaseCallsLocked(sessionID, code string) {
	for key, flight := range e.browserCalls {
		if len(key) > len(sessionID) && key[:len(sessionID)+1] == sessionID+":" && !flight.complete {
			flight.complete, flight.code = true, code
			close(flight.done)
		}
	}
}
