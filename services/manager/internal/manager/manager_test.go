package manager

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeContainers struct {
	starts  atomic.Int32
	removed chan struct{}
	allowGC chan struct{}
	once    sync.Once
}

func (d *fakeContainers) Execute(_ context.Context, _ record, taskDir string, emit func(string, string)) execution {
	d.starts.Add(1)
	os.MkdirAll(filepath.Join(taskDir, "output"), 0700)
	// Fixtures test orchestration only; never treated as real Playwright evidence.
	os.WriteFile(filepath.Join(taskDir, "output", "report.html"), []byte("<html>fixture</html>"), 0600)
	os.WriteFile(filepath.Join(taskDir, "output", "results.json"), []byte(`{"stats":{"expected":1,"unexpected":0},"errors":[]}`), 0600)
	os.WriteFile(filepath.Join(taskDir, "output", "result.json"), []byte(`{"status":"succeeded"}`), 0600)
	emit("started", "fixture started")
	return execution{ExitCode: 0}
}

func (d *fakeContainers) Remove(ctx context.Context, _ record) error {
	d.once.Do(func() { close(d.removed) })
	select {
	case <-d.allowGC:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestManagerDispatchDedupAndCollectionOrdering(t *testing.T) {
	workDir := t.TempDir()
	m, err := New(Config{ServerURL: "http://server.invalid", Token: "test-token", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: workDir, MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	docker := &fakeContainers{removed: make(chan struct{}), allowGC: make(chan struct{})}
	m.docker = docker
	var uploads atomic.Int32
	m.http.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != "POST" || req.Header.Get("Authorization") != "Bearer test-token" || !uuidPattern.MatchString(req.Header.Get("X-Attempt-Id")) {
			t.Error("invalid artifact request")
		}
		body, err := io.ReadAll(req.Body)
		if err != nil || len(body) == 0 {
			t.Error("empty artifact upload")
		}
		for _, r := range m.snapshot() {
			if r.Phase == "complete" {
				t.Error("task completed before all uploads succeeded")
			}
		}
		uploads.Add(1)
		return &http.Response{StatusCode: 201, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dispatch := message("manager-test", "dispatch", newID(), newID(), Dispatch{Kind: "run", Script: "fixture", TimeoutMS: 1000})
	// No socket is needed: ACK send fails offline, but durable acceptance must
	// still start exactly one Worker, just as it would for a lost ACK.
	_ = m.accept(ctx, dispatch)
	select {
	case <-docker.removed:
	case <-time.After(5 * time.Second):
		t.Fatal("container removal not attempted")
	}
	_ = m.accept(ctx, dispatch)
	if docker.starts.Load() != 1 || uploads.Load() != 0 {
		t.Fatal("duplicate execution or uploads before container removal")
	}
	other := message("manager-test", "dispatch", newID(), newID(), Dispatch{Kind: "run", Script: "fixture", TimeoutMS: 1000})
	if err := m.accept(ctx, other); err == nil || !strings.Contains(err.Error(), "slot is occupied") {
		t.Fatal("accepted a second task before cleanup")
	}
	close(docker.allowGC)
	completed := make(chan struct{})
	go func() { m.wg.Wait(); close(completed) }()
	select {
	case <-completed:
	case <-time.After(5 * time.Second):
		t.Fatal("collection did not complete")
	}
	if uploads.Load() != 2 {
		t.Fatal("both artifacts were not uploaded")
	}
	records, err := loadRecords(workDir)
	if err != nil {
		t.Fatal(err)
	}
	r := records[dispatch.AttemptID]
	if r.Phase != "complete" || r.Result == nil || r.Result.Status != "succeeded" {
		t.Fatalf("terminal journal not persisted: %+v", r)
	}
	m.mu.Lock()
	m.records = records // Simulate reloading persistent state after restart.
	m.mu.Unlock()
	_ = m.accept(ctx, dispatch)
	if docker.starts.Load() != 1 || m.snapshot()[0].ResultMessageID != r.ResultMessageID {
		t.Fatal("completed duplicate did not retain its result without re-execution")
	}
}

func TestCollectResultRejectsFalseSuccess(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "output"), 0700)
	os.WriteFile(filepath.Join(dir, "output", "result.json"), []byte(`{"status":"succeeded"}`), 0600)
	result, _ := collectResult(dir, execution{ExitCode: 0})
	if result.Status != "failed" {
		t.Fatal("missing real reports was accepted as success")
	}
	os.WriteFile(filepath.Join(dir, "output", "report.html"), []byte("fixture"), 0600)
	os.WriteFile(filepath.Join(dir, "output", "results.json"), []byte(`{"stats":{"expected":0,"unexpected":1}}`), 0600)
	result, _ = collectResult(dir, execution{ExitCode: 1})
	if result.Status != "failed" {
		t.Fatal("failed assertion was accepted as success")
	}
	result, _ = collectResult(dir, execution{TimedOut: true, ExitCode: -1})
	if result.Status != "timed_out" {
		t.Fatal("watchdog timeout was not preserved")
	}
}

func TestArtifactSymlinkCannotEscapeOutput(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "output"), 0700)
	os.WriteFile(filepath.Join(dir, "secret"), []byte("host data"), 0600)
	if err := os.Symlink("../secret", filepath.Join(dir, "output", "report.html")); err != nil {
		t.Fatal(err)
	}
	if f, err := openArtifact(dir, "report.html"); err == nil {
		f.Close()
		t.Fatal("artifact escaped output root")
	}
	other := t.TempDir()
	if err := os.Symlink(filepath.Join(dir, "output"), filepath.Join(other, "output")); err != nil {
		t.Fatal(err)
	}
	if f, err := openArtifact(other, "report.html"); err == nil {
		f.Close()
		t.Fatal("output directory escaped task root")
	}
}
