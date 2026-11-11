package manager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type execution struct {
	ExitCode int
	TimedOut bool
	Error    string
}

type containerRuntime interface {
	Execute(context.Context, record, string, func(string, string)) execution
	Remove(context.Context, record) error
}

type dockerCLI struct{ cfg Config }

func (d dockerCLI) name(r record) string {
	owner := sha256.Sum256([]byte(d.cfg.ManagerID))
	return fmt.Sprintf("whippet-%x-%s", owner[:6], strings.ToLower(r.AttemptID))
}

func (d dockerCLI) Execute(ctx context.Context, r record, taskDir string, emit func(string, string)) execution {
	createCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := []string{
		"create", "--pull=never", "--name", d.name(r), "--init",
		"--label", "whippet.manager.id=" + d.cfg.ManagerID,
		"--label", "whippet.run.id=" + r.RunID,
		"--label", "whippet.attempt.id=" + r.AttemptID,
		"--mount", "type=bind,source=" + taskDir + ",target=/work",
		"--memory", "1g", "--cpus", "1", "--pids-limit", "256", "--shm-size", "256m",
		d.cfg.WorkerImage,
	}
	if out, err := exec.CommandContext(createCtx, "docker", args...).CombinedOutput(); err != nil {
		return execution{ExitCode: -1, Error: fmt.Sprintf("docker create: %v: %s", err, clip(string(out), 2000))}
	}
	// Playwright owns timeoutMs; allow startup and report flushing before the
	// independent Manager watchdog force-removes the container.
	runCtx, runCancel := context.WithTimeout(ctx, time.Duration(r.TimeoutMS)*time.Millisecond+30*time.Second)
	defer runCancel()
	cmd := exec.CommandContext(runCtx, "docker", "start", "--attach", d.name(r))
	cmd.Stdout = &lineWriter{emit: emit}
	cmd.Stderr = &lineWriter{emit: emit, stderr: true}
	if err := cmd.Start(); err != nil {
		return execution{ExitCode: -1, Error: "docker start: " + err.Error()}
	}
	emit("started", "Worker container starting")
	waitErr := cmd.Wait()
	if runCtx.Err() != nil {
		return execution{ExitCode: -1, TimedOut: ctx.Err() == nil, Error: runCtx.Err().Error()}
	}
	inspectCtx, inspectCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer inspectCancel()
	out, err := exec.CommandContext(inspectCtx, "docker", "inspect", "--format", "{{json .State}}", d.name(r)).CombinedOutput()
	if err != nil {
		return execution{ExitCode: -1, Error: fmt.Sprintf("docker inspect: %v: %s", err, clip(string(out), 2000))}
	}
	var state struct {
		Running   bool
		ExitCode  int
		OOMKilled bool
		Error     string
	}
	if err := json.Unmarshal(out, &state); err != nil {
		return execution{ExitCode: -1, Error: "invalid Docker state: " + err.Error()}
	}
	if state.Running || state.OOMKilled || state.Error != "" {
		return execution{ExitCode: -1, Error: fmt.Sprintf("abnormal container state: running=%t oomKilled=%t error=%s", state.Running, state.OOMKilled, state.Error)}
	}
	if waitErr != nil && state.ExitCode == 0 {
		return execution{ExitCode: -1, Error: "docker attach failed: " + waitErr.Error()}
	}
	return execution{ExitCode: state.ExitCode}
}

func (d dockerCLI) Remove(ctx context.Context, r record) error {
	out, err := exec.CommandContext(ctx, "docker", "rm", "--force", d.name(r)).CombinedOutput()
	if err != nil && !strings.Contains(string(out), "No such container") {
		return fmt.Errorf("docker rm: %w: %s", err, clip(string(out), 2000))
	}
	return nil
}

// CLI output is bounded and normalized into the contract's NDJSON log events.
type lineWriter struct {
	mu     sync.Mutex
	buf    []byte
	emit   func(string, string)
	stderr bool
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			w.buf = append(w.buf, p[:min(len(p), max(0, 8192-len(w.buf)))]...)
			break
		}
		w.buf = append(w.buf, p[:min(i, max(0, 8192-len(w.buf)))]...)
		line := strings.TrimSpace(string(w.buf))
		w.buf = w.buf[:0]
		p = p[i+1:]
		if line == "" {
			continue
		}
		var event struct {
			Kind    string `json:"kind"`
			Message string `json:"message"`
		}
		if !w.stderr && json.Unmarshal([]byte(line), &event) == nil && event.Message != "" {
			line = event.Message
		}
		w.emit("log", clip(line, 8192))
	}
	return n, nil
}

func clip(s string, length int) string {
	if len(s) > length {
		return s[:length] + "…"
	}
	return s
}
