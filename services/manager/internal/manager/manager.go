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

type Manager struct {
	cfg     Config
	docker  containerRuntime
	http    *http.Client
	lock    *os.File
	mu      sync.Mutex // records and admission
	records map[string]record
	wg      sync.WaitGroup
	connMu  sync.Mutex // serializes writes and connection replacement
	conn    *websocket.Conn
	events  chan Envelope
}

func New(cfg Config) (*Manager, error) {
	lock, err := lockWorkDir(cfg)
	if err != nil {
		return nil, err
	}
	records, err := loadRecords(cfg.WorkDir)
	if err != nil {
		lock.Close()
		return nil, err
	}
	return &Manager{cfg: cfg, docker: dockerCLI{cfg}, http: newHTTPClient(), lock: lock, records: records, events: make(chan Envelope, 64)}, nil
}

func (m *Manager) Close() error {
	m.setConn(nil)
	return m.lock.Close()
}

func (m *Manager) Run(ctx context.Context) error {
	// Recovery never starts a script again. It removes the named container and
	// resumes only collection/upload for accepted attempts.
	for _, r := range m.snapshot() {
		if r.Phase != "complete" {
			m.startAttempt(ctx, r, nil)
		}
	}
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
	conn.MaxPayloadBytes = 6*maxScriptBytes + 65536
	// Publish the connection only after hello, so a concurrent completion cannot
	// send a terminal result before the Server has registered this Manager.
	if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		conn.Close()
		return err
	}
	if err := websocket.JSON.Send(conn, message(m.cfg.ManagerID, "hello", "", "", map[string]int{"capacity": 1})); err != nil {
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
	slog.Info("Manager connected", "managerId", m.cfg.ManagerID, "capacity", 1)
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
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
		if err := websocket.JSON.Receive(conn, &env); err != nil {
			return err
		}
		if env.Type == "dispatch" {
			if err := m.accept(ctx, env); err != nil {
				slog.Warn("dispatch not acknowledged", "runId", env.RunID, "error", err)
			}
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
	active := make([]map[string]string, 0)
	for _, r := range m.snapshot() {
		if r.Phase != "complete" {
			active = append(active, map[string]string{"runId": r.RunID, "attemptId": r.AttemptID})
		}
	}
	return m.send(message(m.cfg.ManagerID, "heartbeat", "", "", map[string]any{"active": active}))
}

func (m *Manager) accept(ctx context.Context, env Envelope) error {
	if env.ProtocolVersion != 1 || env.ManagerID != m.cfg.ManagerID || !uuidPattern.MatchString(env.MessageID) || !uuidPattern.MatchString(env.RunID) || !uuidPattern.MatchString(env.AttemptID) {
		return errors.New("invalid v1 dispatch envelope")
	}
	var dispatch Dispatch
	if err := json.Unmarshal(env.Payload, &dispatch); err != nil {
		return fmt.Errorf("invalid dispatch: %w", err)
	}
	if dispatch.Kind != "run" || strings.TrimSpace(dispatch.Script) == "" || len(dispatch.Script) > maxScriptBytes || dispatch.TimeoutMS < 1 || dispatch.TimeoutMS > 3600000 {
		return errors.New("dispatch requires kind=run, a script <=2MiB, and timeoutMs between 1 and 3600000")
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
	for _, existing := range m.records {
		if existing.Phase != "complete" {
			m.mu.Unlock()
			return errors.New("M1 Worker slot is occupied, including collection/cleanup")
		}
	}
	r := record{RunID: env.RunID, AttemptID: env.AttemptID, Phase: "accepted", TimeoutMS: dispatch.TimeoutMS, ResultMessageID: newID()}
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
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.runAttempt(ctx, r, dispatch)
	}()
}

func (m *Manager) runAttempt(ctx context.Context, r record, dispatch *Dispatch) {
	outcome := execution{ExitCode: -1}
	if dispatch != nil {
		if err := m.prepare(r, *dispatch); err != nil {
			outcome.Error = "prepare Worker input: " + err.Error()
		} else {
			r.Phase = "running"
			if err := m.store(r); err != nil {
				outcome.Error = "persist running state: " + err.Error()
			} else {
				outcome = m.docker.Execute(ctx, r, m.taskDir(r), func(kind, text string) { m.emit(r, kind, text) })
			}
		}
	}
	// Do this before reading outputs and releasing the slot, including when
	// docker start was killed but the container itself is still running.
	for {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := m.docker.Remove(cleanupCtx, r)
		cancel()
		if err == nil {
			break
		}
		slog.Error("container cleanup failed; slot retained", "attemptId", r.AttemptID, "error", err)
		if !pause(ctx, 3*time.Second) {
			return // The journal remains active for next startup's cleanup.
		}
	}
	if dispatch != nil {
		result, artifacts := collectResult(m.taskDir(r), outcome)
		if ctx.Err() != nil {
			result = Result{Status: "cancelled", Error: "Manager shutdown interrupted the Worker"}
		}
		r.Result, r.Artifacts = &result, artifacts
	} else if r.Result == nil {
		result := Result{Status: "failed", Error: "Manager restarted before terminal state was saved; previous attempt was stopped and will not be rerun"}
		_, r.Artifacts = collectResult(m.taskDir(r), outcome)
		r.Result = &result
	}
	r.Phase = "collecting"
	if !m.storeUntil(ctx, r) {
		return
	}
	for _, name := range r.Artifacts {
		for {
			if err := m.upload(ctx, r, name); err == nil {
				break
			} else {
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
	return atomicJSON(filepath.Join(m.taskDir(r), "input.json"), WorkerInput{r.RunID, r.AttemptID, dispatch.Script, dispatch.TimeoutMS})
}

func (m *Manager) emit(r record, kind, text string) {
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
