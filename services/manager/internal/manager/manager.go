package manager

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

const heartbeatInterval = 10 * time.Second
const connectionReadTimeout = 35 * time.Second

type Manager struct {
	cfg      Config
	docker   containerRuntime
	http     *http.Client
	lock     *os.File
	mu       sync.Mutex // records and admission
	records  map[string]record
	controls map[string]context.CancelFunc // execution only; collection uses service context
	wg       sync.WaitGroup
	connMu   sync.Mutex // serializes writes and connection replacement
	conn     *websocket.Conn
	events   chan Envelope
	liveMu   sync.Mutex
	live     map[string]*liveSession
	secrets  map[string][]string // attempt-local memory only, never journaled
}

func New(cfg Config) (*Manager, error) {
	if cfg.MaxWorkers < 1 {
		return nil, errors.New("MAX_WORKERS must be a positive integer")
	}
	lock, err := lockWorkDir(cfg)
	if err != nil {
		return nil, err
	}
	records, err := loadRecords(cfg.WorkDir)
	if err != nil {
		lock.Close()
		return nil, err
	}
	m := &Manager{cfg: cfg, http: newHTTPClient(), lock: lock, records: records, controls: make(map[string]context.CancelFunc), events: make(chan Envelope, 64), secrets: make(map[string][]string)}
	m.docker = dockerCLI{cfg: cfg, remember: m.rememberCredentials}
	return m, nil
}

func (m *Manager) Close() error {
	m.setConn(nil)
	return m.lock.Close()
}

func (m *Manager) recoverAttempts(ctx context.Context) {
	// Recovery cleans up/resumes collection only, never executes the script.
	for _, r := range m.snapshot() {
		if r.Phase != "complete" {
			m.startAttempt(ctx, r, nil)
		}
	}
}

func (m *Manager) Run(ctx context.Context) error {
	m.recoverAttempts(ctx)
	eventsDone := make(chan struct{})
	go func() {
		defer close(eventsDone)
		for {
			select {
			case <-ctx.Done():
				return
			case event := <-m.events:
				_ = m.send(event) // logs are best effort; results live in the journal.
			}
		}
	}()
	backoff := time.Second
	for ctx.Err() == nil {
		err := m.session(ctx)
		if ctx.Err() != nil {
			break
		}
		slog.Warn("Manager WS disconnected; active Worker continues", "error", err, "retryIn", backoff)
		if !pause(ctx, backoff+time.Duration(rand.IntN(500))*time.Millisecond) {
			break
		}
		backoff = min(backoff*2, 15*time.Second)
	}
	m.setConn(nil)
	m.wg.Wait() // Each Worker attempts forced cleanup even during shutdown.
	<-eventsDone
	return nil
}

func (m *Manager) session(ctx context.Context) error {
	wsURL := "ws" + strings.TrimPrefix(m.cfg.ServerURL, "http") + "/api/manager/connect"
	cfg, err := websocket.NewConfig(wsURL, m.cfg.ServerURL)
	if err != nil {
		return err
	}
	cfg.Header.Set("Authorization", "Bearer "+m.cfg.Token)
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, err := cfg.DialContext(dialCtx)
	cancel()
	if err != nil {
		return err
	}
	// JSON escapes can expand each script byte to six bytes.
	conn.MaxPayloadBytes = 6*maxScriptBytes + 512*1024
	// Publish the connection only after hello, so a concurrent completion cannot
	// send a terminal result before the Server has registered this Manager.
	if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		conn.Close()
		return err
	}
	if err := websocket.JSON.Send(conn, m.hello()); err != nil {
		conn.Close()
		return err
	}
	m.setConn(conn)
	defer m.setConn(nil)
	if err := m.heartbeat(); err != nil {
		return err
	}
	// v1 has no result receipt ACK. Stable terminal message IDs allow safe replay.
	for _, r := range m.snapshot() {
		if r.Phase == "complete" {
			if err := m.sendResult(r); err != nil {
				return err
			}
		}
	}
	slog.Info("Manager connected", "managerId", m.cfg.ManagerID, "capacity", m.cfg.MaxWorkers)
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				conn.Close()
				return
			case <-ticker.C:
				if err := m.heartbeat(); err != nil {
					conn.Close()
					return
				}
			}
		}
	}()
	for {
		var env Envelope
		if err := conn.SetReadDeadline(time.Now().Add(connectionReadTimeout)); err != nil {
			return err
		}
		if err := websocket.JSON.Receive(conn, &env); err != nil {
			return err
		}
		if env.ProtocolVersion != 1 || env.ManagerID != m.cfg.ManagerID {
			return errors.New("invalid Server envelope")
		}
		switch env.Type {
		case "heartbeat_ack":
			// Server liveness reply; receiving it renews the next read deadline.
		case "dispatch":
			if err := m.accept(ctx, env); err != nil {
				slog.Warn("dispatch not acknowledged", "runId", env.RunID, "error", err)
			}
		case "cancel":
			if err := m.cancelAttempt(ctx, env); err != nil {
				slog.Warn("cancel not accepted", "runId", env.RunID, "error", err)
			}
		case "live.start":
			if err := m.startLive(ctx, env); err != nil {
				slog.Warn("live start rejected", "runId", env.RunID)
			}
		case "live.stop":
			_ = m.stopLive(env)
		}
	}
}

func (m *Manager) setConn(conn *websocket.Conn) {
	m.connMu.Lock()
	defer m.connMu.Unlock()
	if m.conn != nil && m.conn != conn {
		m.conn.Close()
	}
	m.conn = conn
}

func (m *Manager) send(env Envelope) error {
	m.connMu.Lock()
	defer m.connMu.Unlock()
	if m.conn == nil {
		return errors.New("Manager is offline")
	}
	if err := m.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	err := websocket.JSON.Send(m.conn, env)
	if err != nil {
		m.conn.Close()
	}
	return err
}

func (m *Manager) heartbeat() error {
	return m.send(m.heartbeatMessage())
}

func (m *Manager) hello() Envelope {
	return message(m.cfg.ManagerID, "hello", "", "", map[string]int{"capacity": m.cfg.MaxWorkers})
}

func (m *Manager) heartbeatMessage() Envelope {
	active := make([]map[string]string, 0)
	for _, r := range m.snapshot() {
		if r.holdsSlot() {
			active = append(active, map[string]string{"runId": r.RunID, "attemptId": r.AttemptID})
		}
	}
	return message(m.cfg.ManagerID, "heartbeat", "", "", map[string]any{"active": active})
}

func (m *Manager) validateCommand(env Envelope) error {
	if env.ProtocolVersion != 1 || env.ManagerID != m.cfg.ManagerID || !uuidPattern.MatchString(env.MessageID) || !uuidPattern.MatchString(env.RunID) || !uuidPattern.MatchString(env.AttemptID) {
		return errors.New("invalid manager command envelope")
	}
	return nil
}

func (m *Manager) accept(ctx context.Context, env Envelope) error {
	if err := m.validateCommand(env); err != nil {
		return err
	}
	var dispatch Dispatch
	if err := json.Unmarshal(env.Payload, &dispatch); err != nil {
		return fmt.Errorf("invalid dispatch: %w", err)
	}
	if err := validDispatch(dispatch); err != nil {
		return err
	}
	m.mu.Lock()
	if existing, found := m.records[env.AttemptID]; found {
		m.mu.Unlock()
		if existing.RunID != env.RunID {
			return errors.New("attemptId already belongs to a different Run")
		}
		if err := m.send(message(m.cfg.ManagerID, "ack", env.RunID, env.AttemptID, struct{}{})); err != nil {
			return err
		}
		if existing.Phase == "complete" {
			return m.sendResult(existing)
		}
		return nil
	}
	active := 0
	for _, existing := range m.records {
		if existing.holdsSlot() {
			active++
		}
	}
	if active >= m.cfg.MaxWorkers {
		m.mu.Unlock()
		return errors.New("Worker slot is occupied; MAX_WORKERS reached, including cleanup")
	}
	r := record{RunID: env.RunID, AttemptID: env.AttemptID, Phase: "accepted", TimeoutMS: dispatch.TimeoutMS, ResultMessageID: newID(), Kind: dispatch.Kind, Author: dispatch.Author, ScriptOrigin: normalizedScriptOrigin(dispatch.ScriptOrigin),
		WorkspaceID: dispatch.WorkspaceID, TestID: dispatch.TestID, WorkspaceContext: dispatch.WorkspaceContext}
	err := atomicJSON(m.journalPath(r), r)
	if err == nil {
		m.records[r.AttemptID] = r
	}
	m.mu.Unlock()
	if err != nil {
		return fmt.Errorf("persist dispatch before ACK: %w", err)
	}
	// A lost ACK must not prevent execution or cause a second execution on retry.
	ackErr := m.send(message(m.cfg.ManagerID, "ack", r.RunID, r.AttemptID, struct{}{}))
	m.startAttempt(ctx, r, &dispatch)
	return ackErr
}

func (m *Manager) startAttempt(ctx context.Context, r record, dispatch *Dispatch) {
	executionCtx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	m.controls[r.AttemptID] = cancel
	if m.records[r.AttemptID].CancelRequested {
		cancel()
	}
	m.mu.Unlock()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer cancel()
		defer func() {
			m.mu.Lock()
			delete(m.controls, r.AttemptID)
			m.mu.Unlock()
		}()
		m.runAttempt(ctx, executionCtx, r, dispatch)
	}()
}

func (m *Manager) runAttempt(ctx, executionCtx context.Context, r record, dispatch *Dispatch) {
	outcome := execution{ExitCode: -1}
	if dispatch != nil && executionCtx.Err() == nil {
		if err := m.prepare(r, *dispatch); err != nil {
			outcome.Error = "prepare Worker input: " + err.Error()
		} else {
			r.Phase = "running"
			if err := m.store(r); err != nil {
				outcome.Error = "persist running state: " + err.Error()
			} else {
				outcome = m.docker.Execute(executionCtx, r, m.taskDir(r), func(kind, text string) { m.emit(r, kind, text) })
			}
		}
	}
	// Do this before reading outputs and releasing the slot, including when
	// docker start was killed but the container itself is still running.
	m.stopAttemptLive(r.AttemptID)
	for !r.Reclaimed {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := m.docker.Remove(cleanupCtx, r)
		cancel()
		if err == nil {
			r.Reclaimed = true
			break
		}
		slog.Error("container cleanup failed; slot retained", "attemptId", r.AttemptID, "error", err)
		if !pause(ctx, 3*time.Second) {
			return // The journal remains active for next startup's cleanup.
		}
	}
	m.mu.Lock()
	r.CredentialsUsed = r.CredentialsUsed || m.records[r.AttemptID].CredentialsUsed
	values := append([]string{}, m.secrets[r.AttemptID]...)
	m.mu.Unlock()
	if r.CredentialsUsed && !r.CredentialsSanitized {
		if err := sanitizeCredentialOutputs(m.taskDir(r), values); err != nil {
			r.Result = &Result{Status: "failed", Error: "Credential evidence could not be safely retained"}
			r.Artifacts = nil
			dispatch = nil
		} else {
			r.CredentialsSanitized = true
		}
	}
	if dispatch != nil {
		result, artifacts := collectAttemptResult(r, m.taskDir(r), outcome)
		if ctx.Err() != nil {
			result = Result{Status: "cancelled", Error: "Manager shutdown interrupted the Worker"}
		}
		r.Result, r.Artifacts = &result, artifacts
	} else if r.Result == nil {
		result := Result{Status: "failed", Error: "Manager restarted before terminal state was saved; previous attempt was stopped and will not be rerun"}
		_, r.Artifacts = collectAttemptResult(r, m.taskDir(r), outcome)
		r.Result = &result
	}
	if dispatch == nil {
		r.Artifacts = filterFailureEvidence(m.taskDir(r), r.Artifacts)
	}
	r.Phase = "collecting"
	if !m.storeUntil(ctx, r) {
		return
	}
	m.mu.Lock()
	delete(m.secrets, r.AttemptID)
	m.mu.Unlock()
	for _, name := range r.Artifacts {
		for {
			if err := m.upload(ctx, r, name); err == nil {
				break
			} else {
				var skipped *skippedEvidenceError
				if errors.As(err, &skipped) {
					slog.Warn("optional failure evidence upload skipped", "attemptId", r.AttemptID, "reason", "http_413")
					kept := make([]string, 0, len(r.Artifacts))
					for _, saved := range r.Artifacts {
						if saved != name {
							kept = append(kept, saved)
						}
					}
					r.Artifacts = kept
					if !m.storeUntil(ctx, r) {
						return
					}
					break
				}
				slog.Warn("artifact upload pending; will retry without rerunning", "attemptId", r.AttemptID, "artifact", name, "error", err)
			}
			if !pause(ctx, 3*time.Second) {
				return
			}
		}
	}
	r.Phase = "complete"
	if !m.storeUntil(ctx, r) {
		return
	}
	// A cancel may have arrived during collection. store merges it under the
	// same lock used to make the terminal state immutable.
	m.mu.Lock()
	r = m.records[r.AttemptID]
	m.mu.Unlock()
	if err := m.sendResult(r); err != nil {
		slog.Info("terminal result retained for reconnect", "attemptId", r.AttemptID)
	}
	if err := os.RemoveAll(m.taskDir(r)); err != nil {
		slog.Warn("uploaded task directory could not be removed", "attemptId", r.AttemptID, "error", err)
	}
}

func (m *Manager) prepare(r record, dispatch Dispatch) error {
	if err := os.Mkdir(m.taskDir(r), 0700); err != nil {
		return err
	}
	if err := os.Mkdir(filepath.Join(m.taskDir(r), "live"), 0700); err != nil {
		return err
	}
	return atomicJSON(filepath.Join(m.taskDir(r), "input.json"), WorkerInput{
		RunID: r.RunID, AttemptID: r.AttemptID, Script: dispatch.Script, TimeoutMS: dispatch.TimeoutMS,
		Kind: dispatch.Kind, Author: dispatch.Author, ScriptOrigin: normalizedScriptOrigin(dispatch.ScriptOrigin),
		WorkspaceSettings: dispatch.WorkspaceSettings,
		WorkspaceID:       dispatch.WorkspaceID, TestID: dispatch.TestID, WorkspaceContext: dispatch.WorkspaceContext,
	})
}

func (m *Manager) emit(r record, kind, text string) {
	text = m.redactCredentialLog(r.AttemptID, text)
	if r.Kind == "author" {
		if kind == "started" {
			text = "Author Worker started"
		} else if kind != "log" || !authorProgressPattern.MatchString(text) {
			return // Never forward provider/browser stderr or model/tool content.
		}
	}
	event := message(m.cfg.ManagerID, "event", r.RunID, r.AttemptID, map[string]string{"eventId": newID(), "kind": kind, "message": clip(text, 8192)})
	if kind == "started" {
		// A queued started event must never arrive after the terminal result.
		_ = m.send(event)
		return
	}
	select {
	case m.events <- event:
	default: // Avoid unbounded buffering or making test execution wait on logs.
	}
}

func (m *Manager) sendResult(r record) error {
	env := message(m.cfg.ManagerID, "result", r.RunID, r.AttemptID, r.Result)
	env.MessageID = r.ResultMessageID
	return m.send(env)
}

func (m *Manager) snapshot() []record {
	m.mu.Lock()
	defer m.mu.Unlock()
	values := make([]record, 0, len(m.records))
	for _, r := range m.records {
		values = append(values, r)
	}
	return values
}

func (m *Manager) store(r record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.records[r.AttemptID]; ok {
		r.CancelRequested = r.CancelRequested || existing.CancelRequested
		r.CredentialsUsed = r.CredentialsUsed || existing.CredentialsUsed
	}
	if r.CancelRequested && r.Result != nil {
		result := Result{Status: "cancelled", Error: "Server requested cancellation of this attempt"}
		r.Result = &result
	}
	if err := atomicJSON(m.journalPath(r), r); err != nil {
		return err
	}
	m.records[r.AttemptID] = r
	return nil
}

func (m *Manager) storeUntil(ctx context.Context, r record) bool {
	for {
		if err := m.store(r); err == nil {
			return true
		} else {
			slog.Error("journal write failed; slot retained", "attemptId", r.AttemptID, "error", err)
		}
		if !pause(ctx, 3*time.Second) {
			return false
		}
	}
}

func (m *Manager) taskDir(r record) string {
	return filepath.Join(m.cfg.WorkDir, "runs", r.AttemptID)
}

func (m *Manager) journalPath(r record) string {
	return filepath.Join(m.cfg.WorkDir, "journal", r.AttemptID+".json")
}

func pause(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
