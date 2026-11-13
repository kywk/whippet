package manager

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

type dockerSessionRuntime struct {
	cfg     Config
	mu      sync.Mutex
	writers map[string]*attemptInputWriter
}

func newDockerSessionRuntime(cfg Config) *dockerSessionRuntime {
	return &dockerSessionRuntime{cfg: cfg, writers: make(map[string]*attemptInputWriter)}
}
func (d *dockerSessionRuntime) name(r sessionRecord) string {
	owner := sha256.Sum256([]byte(d.cfg.ManagerID))
	return fmt.Sprintf("whippet-%x-session-%s", owner[:6], r.LeaseID)
}
func (d *dockerSessionRuntime) Start(ctx context.Context, r sessionRecord, taskDir string, ready func(), result func(sessionToolResult)) error {
	createCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	args := []string{"create", "--pull=never", "--name", d.name(r), "--init", "--interactive", "--label", "whippet.manager.id=" + d.cfg.ManagerID, "--label", "whippet.session.id=" + r.SessionID, "--label", "whippet.lease.id=" + r.LeaseID, "--mount", "type=bind,source=" + taskDir + ",target=/work", "--memory", "1g", "--cpus", "1", "--pids-limit", "256", "--shm-size", "256m", d.cfg.WorkerImage, "node", "dist/session/main.js"}
	cmd := dockerCommand(createCtx, args...)
	_, err := cmd.CombinedOutput()
	cancel()
	if err != nil {
		return errors.New("session container create failed")
	}
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	cmd = dockerCommand(runCtx, "start", "--attach", "--interactive", d.name(r))
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return errors.New("session stdin unavailable")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return errors.New("session stdout unavailable")
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		return errors.New("session container start failed")
	}
	writer := &attemptInputWriter{ctx: runCtx, input: stdin}
	d.mu.Lock()
	d.writers[r.LeaseID] = writer
	d.mu.Unlock()
	defer func() { d.mu.Lock(); delete(d.writers, r.LeaseID); d.mu.Unlock(); writer.close(); _ = stdin.Close() }()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), maxSessionWireBytes)
	seenReady := false
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		var kind struct {
			Kind string `json:"kind"`
		}
		if len(line) == 0 || !json.Valid(line) || json.Unmarshal(line, &kind) != nil {
			stop()
			break
		}
		switch kind.Kind {
		case "session_ready":
			var frame struct {
				Kind      string `json:"kind"`
				SessionID string `json:"sessionId"`
				LeaseID   string `json:"leaseId"`
			}
			if seenReady || !exactWorkspaceObject(line, "kind", "sessionId", "leaseId") || json.Unmarshal(line, &frame) != nil || frame.SessionID != r.SessionID || frame.LeaseID != r.LeaseID {
				stop()
				break
			}
			seenReady = true
			ready()
		case "tool_result":
			var frame struct {
				Kind      string          `json:"kind"`
				SessionID string          `json:"sessionId"`
				LeaseID   string          `json:"leaseId"`
				CallID    string          `json:"callId"`
				Result    json.RawMessage `json:"result"`
				Error     string          `json:"error"`
			}
			validShape := exactWorkspaceObject(line, "kind", "sessionId", "leaseId", "callId", "result") || exactWorkspaceObject(line, "kind", "sessionId", "leaseId", "callId", "error")
			if !seenReady || !validShape || json.Unmarshal(line, &frame) != nil || frame.SessionID != r.SessionID || frame.LeaseID != r.LeaseID || !uuidPattern.MatchString(frame.CallID) || len(frame.Result) > 0 && frame.Error != "" {
				stop()
				break
			}
			if frame.Error != "" && !validSessionError(frame.Error) {
				stop()
				break
			}
			result(sessionToolResult{SessionID: r.SessionID, LeaseID: r.LeaseID, CallID: frame.CallID, Result: frame.Result, Error: frame.Error})
		default:
			stop()
		}
		if runCtx.Err() != nil {
			break
		}
	}
	if scanner.Err() != nil {
		stop()
	}
	err = cmd.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil || !seenReady {
		return errors.New("session worker failed")
	}
	return errors.New("session worker exited")
}
func (d *dockerSessionRuntime) Send(r sessionRecord, call sessionToolCall) error {
	d.mu.Lock()
	writer := d.writers[r.LeaseID]
	d.mu.Unlock()
	if writer == nil {
		return errors.New("session unavailable")
	}
	frame := struct {
		Kind      string          `json:"kind"`
		SessionID string          `json:"sessionId"`
		LeaseID   string          `json:"leaseId"`
		CallID    string          `json:"callId"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}{"tool_call", r.SessionID, r.LeaseID, call.CallID, call.Name, call.Arguments}
	raw, err := json.Marshal(frame)
	if err != nil || len(raw)+1 > maxSessionWireBytes {
		return errors.New("invalid session frame")
	}
	_, err = writer.Write(append(raw, '\n'))
	return err
}
func (d *dockerSessionRuntime) Remove(ctx context.Context, r sessionRecord) error {
	name := d.name(r)
	inspectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	out, err := dockerCommand(inspectCtx, "inspect", "--format", "{{json .Config.Labels}}", name).CombinedOutput()
	cancel()
	if err != nil {
		// A missing exact deterministic container name is already reclaimed.
		if bytes.Contains(out, []byte("No such object")) || bytes.Contains(out, []byte("No such container")) {
			return nil
		}
		return errors.New("session inspect failed")
	}
	var labels map[string]string
	if json.Unmarshal(out, &labels) != nil || labels["whippet.manager.id"] != d.cfg.ManagerID || labels["whippet.session.id"] != r.SessionID || labels["whippet.lease.id"] != r.LeaseID {
		return errors.New("session container label mismatch")
	}
	stopCtx, stop := context.WithTimeout(ctx, 7*time.Second)
	_ = dockerCommand(stopCtx, "stop", "--time", "5", name).Run()
	stop()
	out, err = dockerCommand(ctx, "rm", "--force", name).CombinedOutput()
	if err != nil && !bytes.Contains(out, []byte("No such container")) {
		return errors.New("session removal failed")
	}
	return nil
}

const maxSessionWireBytes = 14 << 20

func validSessionError(value string) bool {
	switch value {
	case "session_unavailable", "tool_unavailable", "invalid_request", "busy", "unknown_result", "cancelled", "timeout":
		return true
	}
	return false
}
