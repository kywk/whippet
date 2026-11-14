package manager

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

type sessionLiveStart struct {
	SessionID string          `json:"sessionId"`
	LeaseID   string          `json:"leaseId"`
	ViewerID  string          `json:"viewerId"`
	ICE       json.RawMessage `json:"iceServers,omitempty"`
}

func sessionLiveKey(id string) string { return "session:" + id }

func (m *Manager) startSessionLive(ctx context.Context, env Envelope) error {
	if m.validateSessionEnvelope(env) != nil || len(env.Payload) > maxLiveJSON ||
		!exactWorkspaceObject(env.Payload, "sessionId", "leaseId", "viewerId", "iceServers") {
		return errors.New("invalid session.live.start")
	}
	var start sessionLiveStart
	if json.Unmarshal(env.Payload, &start) != nil || !uuidPattern.MatchString(start.SessionID) ||
		!uuidPattern.MatchString(start.LeaseID) || !uuidPattern.MatchString(start.ViewerID) || !validLiveICE(start.ICE) {
		return errors.New("invalid session.live.start")
	}
	m.mu.Lock()
	r, ok := m.sessions[start.SessionID]
	active := ok && r.LeaseID == start.LeaseID && r.State == "ready" && !r.Reclaimed && time.Now().UnixMilli() < r.DeadlineAt
	m.mu.Unlock()
	if !active {
		return errors.New("session live lease unavailable")
	}
	key := sessionLiveKey(start.SessionID)
	m.liveMu.Lock()
	if m.live == nil {
		m.live = make(map[string]*liveSession)
	}
	previous := m.live[key]
	if previous != nil && previous.viewerID == start.ViewerID {
		m.liveMu.Unlock()
		return nil
	}
	if previous != nil {
		previous.cancel()
	}
	liveCtx, cancel := context.WithCancel(ctx)
	session := &liveSession{start.ViewerID, cancel, make(chan struct{})}
	m.live[key] = session
	m.wg.Add(1)
	m.liveMu.Unlock()
	go func() {
		defer m.wg.Done()
		defer cancel()
		defer close(session.done)
		defer func() {
			m.liveMu.Lock()
			if m.live[key] == session {
				delete(m.live, key)
			}
			m.liveMu.Unlock()
		}()
		if previous != nil {
			select {
			case <-previous.done:
			case <-liveCtx.Done():
				return
			}
		}
		wsURL := "ws" + strings.TrimPrefix(m.cfg.ServerURL, "http") + "/api/manager/browser-sessions/" + r.SessionID + "/leases/" + r.LeaseID + "/live?viewerId=" + url.QueryEscape(start.ViewerID)
		source := liveMediaSource{url: wsURL, dir: filepath.Join(m.cfg.WorkDir, "runs", "session-"+r.SessionID), active: func() bool {
			m.mu.Lock()
			defer m.mu.Unlock()
			current, found := m.sessions[r.SessionID]
			return found && current.LeaseID == r.LeaseID && current.State == "ready" && !current.Reclaimed && time.Now().UnixMilli() < current.DeadlineAt
		}}
		_ = m.mediaSessionFor(liveCtx, source, liveStart{ViewerID: start.ViewerID, ICE: start.ICE})
	}()
	return nil
}

func (m *Manager) stopSessionLive(env Envelope) error {
	if m.validateSessionEnvelope(env) != nil || !exactWorkspaceObject(env.Payload, "sessionId", "leaseId", "viewerId") {
		return errors.New("invalid session.live.stop")
	}
	var stop sessionLiveStart
	if json.Unmarshal(env.Payload, &stop) != nil || !uuidPattern.MatchString(stop.SessionID) ||
		!uuidPattern.MatchString(stop.LeaseID) || !uuidPattern.MatchString(stop.ViewerID) {
		return errors.New("invalid session.live.stop")
	}
	m.mu.Lock()
	r, ok := m.sessions[stop.SessionID]
	m.mu.Unlock()
	if ok && r.LeaseID != stop.LeaseID {
		return errors.New("session live lease mismatch")
	}
	m.liveMu.Lock()
	if session := m.live[sessionLiveKey(stop.SessionID)]; session != nil && session.viewerID == stop.ViewerID {
		session.cancel()
	}
	m.liveMu.Unlock()
	return nil
}

func (m *Manager) stopSessionLiveByID(id string) {
	m.liveMu.Lock()
	if session := m.live[sessionLiveKey(id)]; session != nil {
		session.cancel()
	}
	m.liveMu.Unlock()
}
