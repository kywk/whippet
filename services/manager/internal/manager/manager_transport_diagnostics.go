package manager

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Process-local, optional evidence. It has no task identity or transport payload.
type managerTransportDiagnostic struct {
	mu                     sync.Mutex
	workDir                string
	started                time.Time
	connectionStage        string
	resultSendStage        string
	connectionAttemptCount int
	generation             uint64
	resultSendCount        int
	replayCount            int
}

func newManagerTransportDiagnostic(workDir string) *managerTransportDiagnostic {
	return &managerTransportDiagnostic{workDir: workDir, started: time.Now(), connectionStage: "UNOBSERVED", resultSendStage: "NOT_ATTEMPTED"}
}

func saturatingIncrement(value int) int {
	if value < 1000000 {
		return value + 1
	}
	return value
}

func (d *managerTransportDiagnostic) connection(stage string, attempt ...uint64) uint64 {
	if d == nil {
		return 0
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(attempt) != 0 && attempt[0] != d.generation {
		return d.generation
	}
	switch stage {
	case "DIAL_START", "DIAL_FAILED", "HELLO_SENT", "HEARTBEAT_SENT", "REPLAY_START", "READ_LOOP", "DISCONNECTED", "UNOBSERVED":
	default:
		return d.generation
	}
	if d.connectionStage == "DISCONNECTED" && stage == "HEARTBEAT_SENT" {
		return d.generation
	}
	if stage == "DIAL_START" {
		d.connectionAttemptCount = saturatingIncrement(d.connectionAttemptCount)
		d.generation++
	}
	d.connectionStage = stage
	_ = d.writeLocked()
	return d.generation
}

func (d *managerTransportDiagnostic) result(stage string, replay bool) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	switch stage {
	case "NOT_ATTEMPTED", "ATTEMPTED", "SENT", "FAILED", "UNOBSERVED":
	default:
		return
	}
	if stage == "ATTEMPTED" {
		d.resultSendCount = saturatingIncrement(d.resultSendCount)
		if replay {
			d.replayCount = saturatingIncrement(d.replayCount)
		}
	}
	d.resultSendStage = stage
	_ = d.writeLocked()
}

// Caller holds only d.mu. No Manager state, environment, token or journal is read.
func (d *managerTransportDiagnostic) writeLocked() error {
	elapsed := time.Since(d.started).Milliseconds()
	if elapsed < 0 {
		elapsed = 0
	} else if elapsed > 2147483647 {
		elapsed = 2147483647
	}
	raw, err := json.Marshal(struct {
		SchemaVersion          int    `json:"schemaVersion"`
		ConnectionStage        string `json:"connectionStage"`
		ResultSendStage        string `json:"resultSendStage"`
		ConnectionAttemptCount int    `json:"connectionAttemptCount"`
		ResultSendCount        int    `json:"resultSendCount"`
		ReplayCount            int    `json:"replayCount"`
		ElapsedMS              int64  `json:"elapsedMs"`
	}{1, d.connectionStage, d.resultSendStage, d.connectionAttemptCount, d.resultSendCount, d.replayCount, elapsed})
	if err != nil || len(raw)+1 > 4096 {
		return errCapability
	}
	work, err := os.OpenFile(d.workDir, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer work.Close()
	root, err := os.OpenRoot(filepath.Join("/dev/fd", strconv.Itoa(int(work.Fd()))))
	if err != nil {
		return err
	}
	defer root.Close()
	if err = root.Mkdir("diagnostics", 0700); err != nil && !os.IsExist(err) {
		return err
	}
	dir, err := root.OpenFile("diagnostics", os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err = dir.Chmod(0700); err != nil {
		return err
	}
	pinned, err := os.OpenRoot(filepath.Join("/dev/fd", strconv.Itoa(int(dir.Fd()))))
	if err != nil {
		return err
	}
	defer pinned.Close()
	const temp = "manager-transport.tmp"
	if err = pinned.Remove(temp); err != nil && !os.IsNotExist(err) {
		return err
	}
	f, err := pinned.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(append(raw, '\n')); err != nil {
		f.Close()
		_ = pinned.Remove(temp)
		return err
	}
	if err = f.Close(); err != nil {
		_ = pinned.Remove(temp)
		return err
	}
	if err = pinned.Rename(temp, "manager-transport.json"); err != nil {
		_ = pinned.Remove(temp)
		return err
	}
	return nil
}
