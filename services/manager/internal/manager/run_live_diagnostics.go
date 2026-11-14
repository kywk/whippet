package manager

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const maxRunLiveDiagnosticBytes = 4 << 10
const maxRunLiveDiagnosticEvents = 16

type runLiveEvent struct {
	Stage       string    `json:"stage"`
	Error       string    `json:"error"`
	RecordPhase string    `json:"recordPhase"`
	Active      bool      `json:"active"`
	At          time.Time `json:"at"`
}

type runLiveDiagnostic struct {
	RunID     string         `json:"runId"`
	AttemptID string         `json:"attemptId"`
	ViewerID  string         `json:"viewerId"`
	Events    []runLiveEvent `json:"events"`
}

var runLiveStages = map[string]bool{
	"command_received": true, "command_rejected": true,
	"media_connecting": true, "media_connected": true, "media_failed": true,
	"control_written": true, "state_forwarded": true, "frame_forwarded": true, "closed": true,
}

var runLiveErrors = map[string]bool{
	"none": true, "invalid_command": true, "invalid_ice": true,
	"attempt_inactive": true, "author_browser_disabled": true,
	"media_connect_failed": true, "media_stream_failed": true,
	"control_write_failed": true, "frame_send_failed": true,
}

var runLivePhases = map[string]bool{
	"missing": true, "accepted": true, "running": true,
	"collecting": true, "complete": true, "other": true,
}

func (m *Manager) runLiveRecordState(runID, attemptID string) (string, bool) {
	m.mu.Lock()
	r, found := m.records[attemptID]
	m.mu.Unlock()
	if !found || r.RunID != runID {
		return "missing", false
	}
	phase := r.Phase
	if !runLivePhases[phase] {
		phase = "other"
	}
	active := r.holdsSlot() && (r.Phase == "accepted" || r.Phase == "running") && !r.CancelRequested &&
		(r.Author == nil || authorWantsBrowser(r.Author))
	return phase, active
}

// Best-effort, always-on metadata for one normal Run viewer. The only persisted
// values are UUIDs, fixed enums, a boolean and bounded timestamps. Never read
// or write transport errors, URLs, SDP, ICE values, frames, or task output.
func (m *Manager) recordRunLiveDiagnostic(runID, attemptID, viewerID, stage, code string) {
	if m.cfg.WorkDir == "" || !uuidPattern.MatchString(runID) || !uuidPattern.MatchString(attemptID) ||
		!uuidPattern.MatchString(viewerID) || !runLiveStages[stage] || !runLiveErrors[code] {
		return
	}
	phase, active := m.runLiveRecordState(runID, attemptID)
	m.diagnosticsMu.Lock()
	defer m.diagnosticsMu.Unlock()

	dir := filepath.Join(m.cfg.WorkDir, "diagnostics")
	if err := os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
		return
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 {
		return
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return
	}
	defer root.Close()
	name := "run-" + attemptID + "-" + viewerID + ".json"
	diagnostic := runLiveDiagnostic{RunID: runID, AttemptID: attemptID, ViewerID: viewerID, Events: []runLiveEvent{}}
	if priorInfo, err := root.Lstat(name); err == nil {
		if !priorInfo.Mode().IsRegular() || priorInfo.Size() > maxRunLiveDiagnosticBytes || priorInfo.Mode().Perm() != 0600 {
			return
		}
		file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return
		}
		raw, readErr := io.ReadAll(io.LimitReader(file, maxRunLiveDiagnosticBytes+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || len(raw) > maxRunLiveDiagnosticBytes || json.Unmarshal(raw, &diagnostic) != nil ||
			diagnostic.RunID != runID || diagnostic.AttemptID != attemptID || diagnostic.ViewerID != viewerID || len(diagnostic.Events) > maxRunLiveDiagnosticEvents {
			return
		}
		for _, event := range diagnostic.Events {
			if !runLiveStages[event.Stage] || !runLiveErrors[event.Error] || !runLivePhases[event.RecordPhase] || event.At.IsZero() {
				return
			}
		}
	} else if !os.IsNotExist(err) {
		return
	}
	if count := len(diagnostic.Events); count > 0 {
		last := diagnostic.Events[count-1]
		if last.Stage == stage && last.Error == code && last.RecordPhase == phase && last.Active == active {
			return
		}
	}
	diagnostic.Events = append(diagnostic.Events, runLiveEvent{Stage: stage, Error: code, RecordPhase: phase, Active: active, At: time.Now().UTC()})
	if len(diagnostic.Events) > maxRunLiveDiagnosticEvents {
		diagnostic.Events = diagnostic.Events[len(diagnostic.Events)-maxRunLiveDiagnosticEvents:]
	}
	var raw []byte
	for {
		raw, err = json.Marshal(diagnostic)
		if err != nil {
			return
		}
		if len(raw) <= maxRunLiveDiagnosticBytes {
			break
		}
		if len(diagnostic.Events) <= 1 {
			return
		}
		diagnostic.Events = diagnostic.Events[1:]
	}
	temp := ".run-live-" + newID() + ".tmp"
	file, err := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return
	}
	defer root.Remove(temp)
	_, writeErr := file.Write(raw)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil || root.Rename(temp, name) != nil {
		return
	}
	if directory, err := root.Open("."); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
}
