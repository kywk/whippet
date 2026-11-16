package manager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type sessionOpen struct {
	SessionID           string          `json:"sessionId"`
	LeaseID             string          `json:"leaseId"`
	WorkspaceID         string          `json:"workspaceId"`
	WorkspaceContext    json.RawMessage `json:"workspaceContext"`
	AllowedTools        []string        `json:"allowedTools"`
	ToolRegistryVersion string          `json:"toolRegistryVersion"`
	ToolRegistrySHA256  string          `json:"toolRegistrySha256"`
	IdleTimeoutMS       int64           `json:"idleTimeoutMs"`
	MaxLifetimeMS       int64           `json:"maxLifetimeMs"`
}
type sessionClose struct {
	SessionID string `json:"sessionId"`
	LeaseID   string `json:"leaseId"`
}
type sessionToolCall struct {
	SessionID string          `json:"sessionId"`
	LeaseID   string          `json:"leaseId"`
	CallID    string          `json:"callId"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}
type sessionToolResult struct {
	SessionID string          `json:"sessionId"`
	LeaseID   string          `json:"leaseId"`
	CallID    string          `json:"callId"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
}
type sessionRecord struct {
	SessionID   string `json:"sessionId"`
	LeaseID     string `json:"leaseId"`
	WorkspaceID string `json:"workspaceId"`
	DeadlineAt  int64  `json:"deadlineAt"`
	State       string `json:"state"`
	Reason      string `json:"reason,omitempty"`
	Reclaimed   bool   `json:"reclaimed"`
}
type sessionRuntime interface {
	Start(context.Context, sessionRecord, string, func(), func(sessionToolResult)) error
	Send(sessionRecord, sessionToolCall) error
	Remove(context.Context, sessionRecord) error
}
type sessionWireError string

func (e sessionWireError) Error() string { return string(e) }

type sessionCallState struct {
	hash   [32]byte
	tool   registryTool
	roleID string
	reply  *sessionToolResult
	timer  *time.Timer
}
type sessionWorkingState struct {
	allowed           map[string]bool
	workspace         *workspaceContext
	registryVersion   string
	registrySHA256    string
	calls             map[string]*sessionCallState
	active            string
	cachedBytes       int
	credentialSeen    map[string]bool
	credentialPending bool
	credentialCount   int
}

const maxSessionCalls = 256
const maxSessionCachedBytes = 2 << 20

func sessionPath(workDir, id string) string {
	return filepath.Join(workDir, "journal", "sessions", id+".json")
}
func (m *Manager) cleanupSessionFiles(id string) error {
	if !uuidPattern.MatchString(id) {
		return errors.New("invalid session id")
	}
	return os.RemoveAll(filepath.Join(m.cfg.WorkDir, "runs", "session-"+id))
}
func loadSessionRecords(workDir string) (map[string]sessionRecord, error) {
	dir := filepath.Join(workDir, "journal", "sessions")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	records := make(map[string]sessionRecord)
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		if !entry.Type().IsRegular() {
			return nil, errors.New("invalid session state file")
		}
		info, err := entry.Info()
		if err != nil || info.Size() > 4096 {
			return nil, errors.New("invalid session state size")
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		var r sessionRecord
		if !exactWorkspaceObject(raw, "sessionId", "leaseId", "workspaceId", "deadlineAt", "state", "reclaimed") && !exactWorkspaceObject(raw, "sessionId", "leaseId", "workspaceId", "deadlineAt", "state", "reason", "reclaimed") || json.Unmarshal(raw, &r) != nil || !uuidPattern.MatchString(r.SessionID) || !uuidPattern.MatchString(r.LeaseID) || !uuidPattern.MatchString(r.WorkspaceID) || entry.Name() != r.SessionID+".json" || r.DeadlineAt <= 0 {
			return nil, errors.New("invalid session state")
		}
		if r.State != "starting" && r.State != "ready" && r.State != "closing" && r.State != "reclaim_pending" {
			return nil, errors.New("invalid session state")
		}
		records[r.SessionID] = r
	}
	return records, nil
}
func (m *Manager) saveSessionLocked(r sessionRecord) error {
	if err := atomicJSON(sessionPath(m.cfg.WorkDir, r.SessionID), r); err != nil {
		return err
	}
	m.sessions[r.SessionID] = r
	return nil
}
func (m *Manager) sessionSlotCountLocked() int {
	n := 0
	for _, r := range m.sessions {
		if !r.Reclaimed {
			n++
		}
	}
	return n
}
func (m *Manager) sessionSlotCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessionSlotCountLocked()
}
func (m *Manager) sessionStates() []map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	states := make([]map[string]string, 0)
	for _, r := range m.sessions {
		if !r.Reclaimed {
			states = append(states, map[string]string{"sessionId": r.SessionID, "leaseId": r.LeaseID, "state": r.State})
		}
	}
	return states
}
func (m *Manager) validateSessionEnvelope(env Envelope) error {
	if env.ProtocolVersion != 1 || env.ManagerID != m.cfg.ManagerID || !uuidPattern.MatchString(env.MessageID) || env.RunID != "" || env.AttemptID != "" {
		return errors.New("invalid session envelope")
	}
	return nil
}
func (m *Manager) handleSessionOpen(ctx context.Context, env Envelope) {
	if m.validateSessionEnvelope(env) != nil {
		return
	}
	err := m.openSession(ctx, env)
	if err == nil {
		return
	}
	var identity sessionClose
	if json.Unmarshal(env.Payload, &identity) != nil || !uuidPattern.MatchString(identity.SessionID) || !uuidPattern.MatchString(identity.LeaseID) {
		return
	}
	code := "session_unavailable"
	var wire sessionWireError
	if errors.As(err, &wire) {
		code = string(wire)
	}
	_ = m.send(message(m.cfg.ManagerID, "session.open_rejected", "", "", map[string]string{"sessionId": identity.SessionID, "leaseId": identity.LeaseID, "error": code}))
}
func (m *Manager) openSession(ctx context.Context, env Envelope) error {
	if err := m.validateSessionEnvelope(env); err != nil {
		return err
	}
	var p sessionOpen
	if len(env.Payload) > 1<<20 || !exactWorkspaceObject(env.Payload, "sessionId", "leaseId", "workspaceId", "workspaceContext", "allowedTools", "toolRegistryVersion", "toolRegistrySha256", "idleTimeoutMs", "maxLifetimeMs") || json.Unmarshal(env.Payload, &p) != nil || !uuidPattern.MatchString(p.SessionID) || !uuidPattern.MatchString(p.LeaseID) || !uuidPattern.MatchString(p.WorkspaceID) || p.IdleTimeoutMS != 600000 || p.MaxLifetimeMS != 1800000 || p.AllowedTools == nil {
		return sessionWireError("invalid_request")
	}
	workspace, err := parseWorkspaceContext(p.WorkspaceContext, p.WorkspaceID)
	if err != nil || workspace == nil || bytes.Equal(bytes.TrimSpace(workspace.Config), []byte("null")) {
		return sessionWireError("invalid_request")
	}
	registry, err := loadToolRegistry()
	if err != nil {
		return sessionWireError("session_unavailable")
	}
	if p.ToolRegistryVersion != registry.Version || p.ToolRegistrySHA256 != registry.SHA256 {
		return sessionWireError("invalid_request")
	}
	allowed := map[string]bool{}
	for _, name := range p.AllowedTools {
		if allowed[name] {
			return sessionWireError("invalid_request")
		}
		allowed[name] = true
		found := false
		for _, tool := range registry.Tools {
			if tool.Name == name && tool.Side == "worker" && tool.Effect == "browser" {
				found = true
			}
		}
		if !found {
			return sessionWireError("invalid_request")
		}
	}
	m.mu.Lock()
	if previous, ok := m.sessions[p.SessionID]; ok {
		m.mu.Unlock()
		if previous.LeaseID != p.LeaseID {
			return sessionWireError("session_unavailable")
		}
		if previous.State == "ready" {
			_ = m.send(message(m.cfg.ManagerID, "session.ready", "", "", sessionClose{p.SessionID, p.LeaseID}))
		} else if previous.State == "closing" || previous.State == "reclaim_pending" || previous.Reclaimed {
			_ = m.send(message(m.cfg.ManagerID, "session.closed", "", "", map[string]any{"sessionId": previous.SessionID, "leaseId": previous.LeaseID, "reason": previous.Reason, "reclaimed": previous.Reclaimed}))
		}
		return nil
	}
	active := m.sessionSlotCountLocked()
	for _, r := range m.records {
		if r.holdsSlot() {
			active++
		}
	}
	if active >= m.cfg.MaxWorkers {
		m.mu.Unlock()
		return sessionWireError("capacity_full")
	}
	r := sessionRecord{SessionID: p.SessionID, LeaseID: p.LeaseID, WorkspaceID: p.WorkspaceID, DeadlineAt: time.Now().Add(30 * time.Minute).UnixMilli(), State: "starting"}
	if err := m.saveSessionLocked(r); err != nil {
		m.mu.Unlock()
		return err
	}
	m.sessionWorking[r.SessionID] = &sessionWorkingState{allowed: allowed, workspace: workspace, registryVersion: p.ToolRegistryVersion, registrySHA256: p.ToolRegistrySHA256, calls: make(map[string]*sessionCallState), credentialSeen: make(map[string]bool)}
	m.mu.Unlock()
	taskDir := filepath.Join(m.cfg.WorkDir, "runs", "session-"+p.SessionID)
	if err := os.MkdirAll(taskDir, 0700); err != nil {
		m.requestSessionClose(p.SessionID, "worker_failed")
		m.wg.Add(1)
		go func() { defer m.wg.Done(); m.reclaimSession(ctx, p.SessionID) }()
		return err
	}
	if err := os.MkdirAll(filepath.Join(taskDir, "live"), 0700); err != nil {
		m.requestSessionClose(p.SessionID, "worker_failed")
		m.wg.Add(1)
		go func() { defer m.wg.Done(); m.reclaimSession(ctx, p.SessionID) }()
		return err
	}
	input := struct {
		Kind                string          `json:"kind"`
		SessionID           string          `json:"sessionId"`
		LeaseID             string          `json:"leaseId"`
		WorkspaceID         string          `json:"workspaceId"`
		WorkspaceContext    json.RawMessage `json:"workspaceContext"`
		AllowedTools        []string        `json:"allowedTools"`
		ToolRegistryVersion string          `json:"toolRegistryVersion"`
		ToolRegistrySHA256  string          `json:"toolRegistrySha256"`
	}{"session", p.SessionID, p.LeaseID, p.WorkspaceID, p.WorkspaceContext, p.AllowedTools, p.ToolRegistryVersion, p.ToolRegistrySHA256}
	if err := atomicJSON(filepath.Join(taskDir, "input.json"), input); err != nil {
		m.requestSessionClose(p.SessionID, "worker_failed")
		m.wg.Add(1)
		go func() { defer m.wg.Done(); m.reclaimSession(ctx, p.SessionID) }()
		return err
	}
	m.startSession(ctx, r, taskDir)
	return nil
}
func (m *Manager) startSession(ctx context.Context, r sessionRecord, taskDir string) {
	deadline := time.UnixMilli(r.DeadlineAt)
	executionCtx, cancel := context.WithDeadline(ctx, deadline)
	m.mu.Lock()
	m.sessionControls[r.SessionID] = cancel
	m.mu.Unlock()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer cancel()
		var idle *time.Timer
		var idleMu sync.Mutex
		ready := func() {
			m.mu.Lock()
			current := m.sessions[r.SessionID]
			active := false
			if current.State == "starting" {
				current.State = "ready"
				active = m.saveSessionLocked(current) == nil
			}
			m.mu.Unlock()
			if active {
				idleMu.Lock()
				idle = time.AfterFunc(m.sessionIdleTimeout, func() { m.requestSessionClose(r.SessionID, "idle_timeout") })
				idleMu.Unlock()
				_ = m.send(message(m.cfg.ManagerID, "session.ready", "", "", sessionClose{r.SessionID, r.LeaseID}))
			} else {
				m.requestSessionClose(r.SessionID, "worker_failed")
			}
		}
		result := func(reply sessionToolResult) {
			m.mu.Lock()
			current := m.sessions[r.SessionID]
			work := m.sessionWorking[r.SessionID]
			if current.State != "ready" || current.Reclaimed || current.LeaseID != reply.LeaseID || work == nil || work.active != reply.CallID {
				m.mu.Unlock()
				return
			}
			call := work.calls[reply.CallID]
			if call == nil {
				m.mu.Unlock()
				return
			}
			if call.timer != nil {
				call.timer.Stop()
			}
			if reply.Error != "" && !validSessionError(reply.Error) || len(reply.Result) > 0 && (len(reply.Result) > int(call.tool.Limits.MaxOutputBytes) || !json.Valid(reply.Result)) || len(reply.Result) == 0 && reply.Error == "" {
				reply.Result = nil
				reply.Error = "unknown_result"
			}
			work.active = ""
			bytes := len(reply.Result) + len(reply.Error) + 128
			over := work.cachedBytes+bytes > maxSessionCachedBytes
			if over {
				reply.Result = nil
				reply.Error = "unknown_result"
				bytes = len(reply.Error) + 128
			}
			work.cachedBytes += bytes
			call.reply = &reply
			m.mu.Unlock()
			idleMu.Lock()
			if idle != nil {
				idle.Reset(m.sessionIdleTimeout)
			}
			idleMu.Unlock()
			_ = m.send(message(m.cfg.ManagerID, "session.reply", "", "", reply))
			if over || reply.Error == "timeout" || reply.Error == "unknown_result" {
				m.requestSessionClose(r.SessionID, "cancelled")
			}
		}
		err := m.sessionsRuntime.Start(executionCtx, r, taskDir, ready, result)
		idleMu.Lock()
		if idle != nil {
			idle.Stop()
		}
		idleMu.Unlock()
		m.mu.Lock()
		current := m.sessions[r.SessionID]
		reason := current.Reason
		m.mu.Unlock()
		if reason == "" {
			if executionCtx.Err() == context.DeadlineExceeded {
				reason = "lifetime_timeout"
			} else if ctx.Err() != nil {
				reason = "manager_restart"
			} else if err != nil {
				reason = "worker_failed"
			} else {
				reason = "worker_failed"
			}
		}
		m.requestSessionClose(r.SessionID, reason)
		m.reclaimSession(ctx, r.SessionID)
		m.mu.Lock()
		delete(m.sessionControls, r.SessionID)
		m.mu.Unlock()
	}()
}
func (m *Manager) requestSessionClose(id, reason string) {
	m.mu.Lock()
	r, ok := m.sessions[id]
	if ok && !r.Reclaimed && (r.State == "starting" || r.State == "ready") {
		r.State = "closing"
		r.Reason = reason
		_ = m.saveSessionLocked(r)
	}
	cancel := m.sessionControls[id]
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	m.stopSessionLiveByID(id)
}
func (m *Manager) closeSession(env Envelope) error {
	if err := m.validateSessionEnvelope(env); err != nil {
		return err
	}
	var p sessionClose
	if !exactWorkspaceObject(env.Payload, "sessionId", "leaseId") || json.Unmarshal(env.Payload, &p) != nil || !uuidPattern.MatchString(p.SessionID) || !uuidPattern.MatchString(p.LeaseID) {
		return errors.New("invalid session.close")
	}
	m.mu.Lock()
	r, ok := m.sessions[p.SessionID]
	m.mu.Unlock()
	if ok && r.LeaseID != p.LeaseID {
		return errors.New("unknown session lease")
	}
	if !ok {
		// A missing journal record is not proof that Docker has reclaimed the
		// lease. Remove checks the deterministic name and all ownership labels;
		// only its confirmed absence/removal permits a terminal reply.
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := m.sessionsRuntime.Remove(cleanupCtx, sessionRecord{SessionID: p.SessionID, LeaseID: p.LeaseID})
		cancel()
		if err != nil {
			return err
		}
		if err := m.cleanupSessionFiles(p.SessionID); err != nil {
			return err
		}
		_ = m.send(message(m.cfg.ManagerID, "session.closed", "", "", map[string]any{"sessionId": p.SessionID, "leaseId": p.LeaseID, "reason": "closed", "reclaimed": true}))
		return nil
	}
	if r.Reclaimed {
		reason := r.Reason
		if reason == "" {
			reason = "closed"
		}
		_ = m.send(message(m.cfg.ManagerID, "session.closed", "", "", map[string]any{"sessionId": r.SessionID, "leaseId": r.LeaseID, "reason": reason, "reclaimed": true}))
		return nil
	}
	m.requestSessionClose(p.SessionID, "closed")
	return nil
}
func (m *Manager) reclaimSession(ctx context.Context, id string) {
	m.stopSessionLiveByID(id)
	m.mu.Lock()
	r := m.sessions[id]
	if r.Reclaimed {
		m.mu.Unlock()
		return
	}
	r.State = "reclaim_pending"
	if r.Reason == "" {
		r.Reason = "manager_restart"
	}
	_ = m.saveSessionLocked(r)
	m.mu.Unlock()
	_ = m.send(message(m.cfg.ManagerID, "session.closed", "", "", map[string]any{"sessionId": r.SessionID, "leaseId": r.LeaseID, "reason": r.Reason, "reclaimed": false}))
	for {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := m.sessionsRuntime.Remove(cleanupCtx, r)
		cancel()
		if err == nil {
			err = m.cleanupSessionFiles(id)
		}
		if err == nil {
			m.mu.Lock()
			current := m.sessions[id]
			current.Reclaimed = true
			err = m.saveSessionLocked(current)
			if err == nil {
				delete(m.sessionWorking, id)
			}
			m.mu.Unlock()
			if err == nil {
				_ = m.send(message(m.cfg.ManagerID, "session.closed", "", "", map[string]any{"sessionId": r.SessionID, "leaseId": r.LeaseID, "reason": r.Reason, "reclaimed": true}))
				return
			}
		}
		if !pause(ctx, 3*time.Second) {
			return
		}
	}
}
func (m *Manager) recoverSessions(ctx context.Context) {
	for _, r := range m.sessions {
		if r.Reclaimed {
			continue
		}
		m.mu.Lock()
		r.State = "reclaim_pending"
		r.Reason = "manager_restart"
		_ = m.saveSessionLocked(r)
		m.mu.Unlock()
		m.wg.Add(1)
		go func(id string) { defer m.wg.Done(); m.reclaimSession(ctx, id) }(r.SessionID)
	}
}
func (m *Manager) callSession(_ context.Context, env Envelope) error {
	if err := m.validateSessionEnvelope(env); err != nil {
		return err
	}
	var p sessionToolCall
	if len(env.Payload) > maxSessionWireBytes || !exactWorkspaceObject(env.Payload, "sessionId", "leaseId", "callId", "name", "arguments") || json.Unmarshal(env.Payload, &p) != nil || !uuidPattern.MatchString(p.SessionID) || !uuidPattern.MatchString(p.LeaseID) || !uuidPattern.MatchString(p.CallID) || p.Name == "" || !json.Valid(p.Arguments) {
		return sessionWireError("invalid_request")
	}
	registry, err := loadToolRegistry()
	if err != nil {
		return sessionWireError("tool_unavailable")
	}
	var tool *registryTool
	for i := range registry.Tools {
		if registry.Tools[i].Name == p.Name {
			tool = &registry.Tools[i]
			break
		}
	}
	if tool == nil || tool.Side != "worker" || tool.Effect != "browser" || int64(len(p.Arguments)) > tool.Limits.MaxInputBytes || !validToolArguments(*tool, p.Arguments) {
		return sessionWireError("invalid_request")
	}
	var normalized any
	if json.Unmarshal(p.Arguments, &normalized) != nil {
		return sessionWireError("invalid_request")
	}
	canonical, _ := json.Marshal(normalized)
	hash := sha256.Sum256(append([]byte(p.Name+"\n"), canonical...))
	m.mu.Lock()
	r, ok := m.sessions[p.SessionID]
	work := m.sessionWorking[p.SessionID]
	if !ok || r.LeaseID != p.LeaseID || r.State != "ready" || r.Reclaimed || time.Now().UnixMilli() >= r.DeadlineAt || work == nil {
		m.mu.Unlock()
		return sessionWireError("session_unavailable")
	}
	if work.registryVersion != registry.Version || work.registrySHA256 != registry.SHA256 {
		m.mu.Unlock()
		m.requestSessionClose(p.SessionID, "worker_failed")
		return sessionWireError("tool_unavailable")
	}
	if !work.allowed[p.Name] {
		m.mu.Unlock()
		return sessionWireError("tool_unavailable")
	}
	if previous := work.calls[p.CallID]; previous != nil {
		if previous.hash != hash {
			m.mu.Unlock()
			return sessionWireError("invalid_request")
		}
		reply := previous.reply
		m.mu.Unlock()
		if reply != nil {
			_ = m.send(message(m.cfg.ManagerID, "session.reply", "", "", reply))
		} else {
			_ = m.send(message(m.cfg.ManagerID, "session.reply", "", "", sessionToolResult{SessionID: p.SessionID, LeaseID: p.LeaseID, CallID: p.CallID, Error: "busy"}))
		}
		return nil
	}
	if work.active != "" {
		m.mu.Unlock()
		_ = m.send(message(m.cfg.ManagerID, "session.reply", "", "", sessionToolResult{SessionID: p.SessionID, LeaseID: p.LeaseID, CallID: p.CallID, Error: "busy"}))
		return nil
	}
	if len(work.calls) >= maxSessionCalls {
		m.mu.Unlock()
		m.requestSessionClose(p.SessionID, "cancelled")
		return sessionWireError("cancelled")
	}
	roleID := ""
	if p.Name == "browser_login" {
		var login struct {
			RoleID string `json:"roleId"`
		}
		if json.Unmarshal(p.Arguments, &login) != nil || !uuidPattern.MatchString(login.RoleID) {
			m.mu.Unlock()
			return sessionWireError("invalid_request")
		}
		roleID = login.RoleID
	}
	work.calls[p.CallID] = &sessionCallState{hash: hash, tool: *tool, roleID: roleID}
	work.active = p.CallID
	m.mu.Unlock()
	timeout := time.Duration(tool.Limits.TimeoutMS)*time.Millisecond + time.Second
	if m.sessionCallTimeoutOverride > 0 {
		timeout = m.sessionCallTimeoutOverride
	}
	timer := time.AfterFunc(timeout, func() {
		m.mu.Lock()
		current := m.sessions[p.SessionID]
		work := m.sessionWorking[p.SessionID]
		if current.State != "ready" || work == nil || work.active != p.CallID {
			m.mu.Unlock()
			return
		}
		work.active = ""
		reply := sessionToolResult{SessionID: p.SessionID, LeaseID: p.LeaseID, CallID: p.CallID, Error: "timeout"}
		work.calls[p.CallID].reply = &reply
		work.cachedBytes += len(reply.Error) + 128
		m.mu.Unlock()
		_ = m.send(message(m.cfg.ManagerID, "session.reply", "", "", reply))
		m.requestSessionClose(p.SessionID, "cancelled")
	})
	m.mu.Lock()
	if work := m.sessionWorking[p.SessionID]; work != nil {
		if call := work.calls[p.CallID]; call != nil && work.active == p.CallID {
			call.timer = timer
		} else {
			timer.Stop()
		}
	}
	m.mu.Unlock()
	if err := m.sessionsRuntime.Send(r, p); err != nil {
		m.mu.Lock()
		if current := m.sessionWorking[p.SessionID]; current != nil && current.active == p.CallID {
			current.active = ""
			if current.calls[p.CallID].timer != nil {
				current.calls[p.CallID].timer.Stop()
			}
			current.calls[p.CallID].reply = &sessionToolResult{SessionID: p.SessionID, LeaseID: p.LeaseID, CallID: p.CallID, Error: "unknown_result"}
		}
		m.mu.Unlock()
		m.requestSessionClose(p.SessionID, "worker_failed")
		return sessionWireError("unknown_result")
	}
	return nil
}
