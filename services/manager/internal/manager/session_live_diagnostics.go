package manager

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type sessionLiveEvent struct {
	Stage string    `json:"stage"`
	Error string    `json:"error"`
	At    time.Time `json:"at"`
}

type sessionLiveDiagnostic struct {
	SessionID string             `json:"sessionId"`
	LeaseID   string             `json:"leaseId"`
	ViewerID  string             `json:"viewerId"`
	Events    []sessionLiveEvent `json:"events"`
}

var sessionLiveStages = map[string]bool{
	"command_received": true, "command_rejected": true, "media_connecting": true,
	"media_connected": true, "control_written": true, "frame_forwarded": true,
	"media_failed": true, "closed": true,
}
var sessionLiveErrors = map[string]bool{
	"none": true, "invalid_command": true, "lease_unavailable": true,
	"media_connect_failed": true, "media_stream_failed": true,
	"control_write_failed": true, "frame_send_failed": true,
}

// Diagnostic writes are best effort and never include transport errors, URLs,
// headers, credentials, frame bytes, or free-form Worker state.
func (m *Manager) recordSessionLiveDiagnostic(sessionID, leaseID, viewerID, stage, code string) {
	if m.cfg.WorkDir == "" || !uuidPattern.MatchString(sessionID) || !uuidPattern.MatchString(leaseID) ||
		!uuidPattern.MatchString(viewerID) || !sessionLiveStages[stage] || !sessionLiveErrors[code] {
		return
	}
	m.diagnosticsMu.Lock()
	defer m.diagnosticsMu.Unlock()
	dir := filepath.Join(m.cfg.WorkDir, "diagnostics")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return
	}
	dirInfo, err := os.Lstat(dir)
	if err != nil || !dirInfo.IsDir() || dirInfo.Mode()&os.ModeSymlink != 0 {
		return
	}
	if dirInfo.Mode().Perm() != 0700 && os.Chmod(dir, 0700) != nil {
		return
	}
	path := filepath.Join(dir, sessionID+".json")
	diagnostic := sessionLiveDiagnostic{SessionID: sessionID, LeaseID: leaseID, ViewerID: viewerID, Events: []sessionLiveEvent{}}
	if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() && info.Size() <= 8192 {
		if raw, err := os.ReadFile(path); err == nil {
			var prior sessionLiveDiagnostic
			if json.Unmarshal(raw, &prior) == nil && prior.SessionID == sessionID && prior.LeaseID == leaseID && prior.ViewerID == viewerID && len(prior.Events) <= 16 {
				valid := true
				for _, event := range prior.Events {
					valid = valid && sessionLiveStages[event.Stage] && sessionLiveErrors[event.Error]
				}
				if valid {
					diagnostic.Events = prior.Events
				}
			}
		}
	}
	if n := len(diagnostic.Events); n > 0 && diagnostic.Events[n-1].Stage == stage && diagnostic.Events[n-1].Error == code {
		return
	}
	diagnostic.Events = append(diagnostic.Events, sessionLiveEvent{Stage: stage, Error: code, At: time.Now().UTC()})
	if len(diagnostic.Events) > 16 {
		diagnostic.Events = diagnostic.Events[len(diagnostic.Events)-16:]
	}
	_ = atomicJSON(path, diagnostic)
}
