package manager

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type lifecycleTask struct {
	finish    chan execution
	reclaim   chan struct{}
	failFirst bool
	starts    int
	removals  int
	live      bool
}

type lifecycleDocker struct {
	mu       sync.Mutex
	tasks    map[string]*lifecycleTask
	started  chan string
	removing chan string
	live     int
	peak     int
}

func newLifecycleDocker() *lifecycleDocker {
	return &lifecycleDocker{tasks: make(map[string]*lifecycleTask), started: make(chan string, 20), removing: make(chan string, 20)}
}

func (d *lifecycleDocker) add(r Envelope) *lifecycleTask {
	task := &lifecycleTask{finish: make(chan execution, 1), reclaim: make(chan struct{})}
	d.mu.Lock()
	d.tasks[r.AttemptID] = task
	d.mu.Unlock()
	return task
}

func (d *lifecycleDocker) Execute(ctx context.Context, r record, _ string, _ func(string, string)) execution {
	d.mu.Lock()
	task := d.tasks[r.AttemptID]
	task.starts++
	task.live = true
	d.live++
	d.peak = max(d.peak, d.live)
	d.mu.Unlock()
	d.started <- r.AttemptID
	select {
	case result := <-task.finish:
		return result
	case <-ctx.Done():
		return execution{ExitCode: -1, Error: ctx.Err().Error()}
	}
}

func (d *lifecycleDocker) Remove(ctx context.Context, r record) error {
	d.mu.Lock()
	task := d.tasks[r.AttemptID]
	fail := false
	if task != nil {
		task.removals++
		fail = task.failFirst && task.removals == 1
	}
	d.mu.Unlock()
	d.removing <- r.AttemptID
	if fail {
		return errors.New("simulated Docker cleanup failure")
	}
	if task == nil {
		return nil // deterministic name does not exist; e.g. lost dispatch
	}
	select {
	case <-task.reclaim:
		d.mu.Lock()
		if task.live {
			task.live = false
			d.live--
		}
		d.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func lifecycleManager(t *testing.T, capacity int) (*Manager, *lifecycleDocker, context.Context) {
	t.Helper()
	m, err := New(Config{ServerURL: "http://server.invalid", Token: "synthetic", ManagerID: "manager-test", WorkerImage: "fixture", WorkDir: t.TempDir(), MaxWorkers: capacity})
	if err != nil {
		t.Fatal(err)
	}
	d := newLifecycleDocker()
	m.docker = d
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		d.mu.Lock()
		for _, task := range d.tasks {
			select {
			case <-task.reclaim:
			default:
				close(task.reclaim)
			}
		}
		d.mu.Unlock()
		m.wg.Wait()
		m.Close()
	})
	return m, d, ctx
}

func dispatchForTest() Envelope {
	return message("manager-test", "dispatch", newID(), newID(), Dispatch{"run", "synthetic fixture", 1000})
}

func awaitAttempt(t *testing.T, events <-chan string, attemptID string) {
	t.Helper()
	select {
	case got := <-events:
		if got != attemptID {
			t.Fatalf("got attempt %s, expected %s", got, attemptID)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("attempt did not reach expected lifecycle step")
	}
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	timer := time.NewTimer(6 * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for !condition() {
		select {
		case <-timer.C:
			t.Fatal("lifecycle condition did not become true")
		case <-ticker.C:
		}
	}
}

func journalRecord(m *Manager, id string) record {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.records[id]
}

func activeCount(t *testing.T, m *Manager) int {
	t.Helper()
	var body struct {
		Active []struct{ RunID, AttemptID string } `json:"active"`
	}
	if err := json.Unmarshal(m.heartbeatMessage().Payload, &body); err != nil {
		t.Fatal(err)
	}
	return len(body.Active)
}

func TestM2CapacityDedupAndAbnormalCleanup(t *testing.T) {
	m, d, ctx := lifecycleManager(t, 2)
	var hello struct{ Capacity int }
	json.Unmarshal(m.hello().Payload, &hello)
	if hello.Capacity != 2 {
		t.Fatal("hello did not advertise configured capacity")
	}
	first, second, third := dispatchForTest(), dispatchForTest(), dispatchForTest()
	one, two, three := d.add(first), d.add(second), d.add(third)
	_ = m.accept(ctx, first) // offline ACK failure must not undo acceptance
	awaitAttempt(t, d.started, first.AttemptID)
	_ = m.accept(ctx, second)
	awaitAttempt(t, d.started, second.AttemptID)
	_ = m.accept(ctx, first)
	if activeCount(t, m) != 2 {
		t.Fatal("heartbeat lost live attempts")
	}
	if err := m.accept(ctx, third); err == nil || !strings.Contains(err.Error(), "MAX_WORKERS") {
		t.Fatal("accepted beyond the global Worker limit")
	}
	one.finish <- execution{ExitCode: 137, Error: "simulated unexpected container exit"}
	awaitAttempt(t, d.removing, first.AttemptID)
	if err := m.accept(ctx, third); err == nil || !strings.Contains(err.Error(), "MAX_WORKERS") {
		t.Fatal("released a slot before abnormal container removal")
	}
	close(one.reclaim)
	eventually(t, func() bool { return journalRecord(m, first.AttemptID).Phase == "complete" })
	if journalRecord(m, first.AttemptID).Result.Status != "failed" {
		t.Fatal("abnormal exit did not fail")
	}
	_ = m.accept(ctx, third)
	awaitAttempt(t, d.started, third.AttemptID)
	two.finish <- execution{ExitCode: 1}
	three.finish <- execution{ExitCode: 1}
	close(two.reclaim)
	close(three.reclaim)
	m.wg.Wait()
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.peak > 2 || one.starts != 1 || two.starts != 1 || three.starts != 1 {
		t.Fatal("duplicate attempt or global capacity violation")
	}
}

func TestM2CancelMatchesAttemptAndWaitsForReclamation(t *testing.T) {
	m, d, ctx := lifecycleManager(t, 1)
	dispatch := dispatchForTest()
	task := d.add(dispatch)
	_ = m.accept(ctx, dispatch)
	awaitAttempt(t, d.started, dispatch.AttemptID)
	wrong := message("manager-test", "cancel", newID(), dispatch.AttemptID, struct{}{})
	if err := m.cancelAttempt(ctx, wrong); err == nil {
		t.Fatal("cancelled an attempt with a mismatched runId")
	}
	cancel := message("manager-test", "cancel", dispatch.RunID, dispatch.AttemptID, struct{}{})
	if err := m.cancelAttempt(ctx, cancel); err != nil {
		t.Fatal(err)
	}
	awaitAttempt(t, d.removing, dispatch.AttemptID) // Execute stopped on context cancellation
	if err := m.cancelAttempt(ctx, cancel); err != nil {
		t.Fatal(err)
	}
	records, err := loadRecords(m.cfg.WorkDir)
	if err != nil || !records[dispatch.AttemptID].CancelRequested {
		t.Fatal("cancellation was not durably saved")
	}
	if r := journalRecord(m, dispatch.AttemptID); r.Result != nil || r.Reclaimed || activeCount(t, m) != 1 {
		t.Fatal("cancellation completed before container removal")
	}
	if err := m.accept(ctx, dispatchForTest()); err == nil || !strings.Contains(err.Error(), "MAX_WORKERS") {
		t.Fatal("cancelling attempt released its slot early")
	}
	close(task.reclaim)
	m.wg.Wait()
	r := journalRecord(m, dispatch.AttemptID)
	if r.Result.Status != "cancelled" || !r.Reclaimed || activeCount(t, m) != 0 {
		t.Fatalf("incorrect final cancellation state: %+v", r)
	}
	_ = m.cancelAttempt(ctx, cancel)
	_ = m.accept(ctx, dispatch)
	if journalRecord(m, dispatch.AttemptID).ResultMessageID != r.ResultMessageID {
		t.Fatal("terminal identity changed on repeated cancel/dispatch")
	}
}

func TestM2CancelDuringCollectionCannotBeOverwritten(t *testing.T) {
	m, _, ctx := lifecycleManager(t, 1)
	dispatch := dispatchForTest()
	stale := record{RunID: dispatch.RunID, AttemptID: dispatch.AttemptID, Phase: "collecting", Reclaimed: true, Result: &Result{Status: "succeeded"}, ResultMessageID: newID()}
	if err := m.store(stale); err != nil {
		t.Fatal(err)
	}
	if err := m.cancelAttempt(ctx, message("manager-test", "cancel", stale.RunID, stale.AttemptID, struct{}{})); err != nil {
		t.Fatal(err)
	}
	stale.Phase = "complete"
	if err := m.store(stale); err != nil {
		t.Fatal(err)
	}
	if journalRecord(m, stale.AttemptID).Result.Status != "cancelled" {
		t.Fatal("collection overwrote a durable cancellation")
	}
}

func TestM2CancelLostDispatchAndRestartNeverReexecute(t *testing.T) {
	m, d, ctx := lifecycleManager(t, 1)
	dispatch := dispatchForTest()
	if err := m.cancelAttempt(ctx, message("manager-test", "cancel", dispatch.RunID, dispatch.AttemptID, struct{}{})); err != nil {
		t.Fatal(err)
	}
	m.wg.Wait()
	_ = m.accept(ctx, dispatch) // late dispatch must see the cancellation tombstone
	if journalRecord(m, dispatch.AttemptID).Result.Status != "cancelled" {
		t.Fatal("cancel-before-dispatch did not persist its terminal state")
	}
	interrupted := record{RunID: newID(), AttemptID: newID(), Phase: "running", TimeoutMS: 1000, ResultMessageID: newID()}
	if err := m.store(interrupted); err != nil {
		t.Fatal(err)
	}
	cancelled := record{RunID: newID(), AttemptID: newID(), Phase: "running", TimeoutMS: 1000, ResultMessageID: newID(), CancelRequested: true}
	if err := m.store(cancelled); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadRecords(m.cfg.WorkDir)
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.records = loaded
	m.mu.Unlock()
	m.recoverAttempts(ctx)
	m.wg.Wait()
	if journalRecord(m, interrupted.AttemptID).Result.Status != "failed" || journalRecord(m, cancelled.AttemptID).Result.Status != "cancelled" {
		t.Fatal("restart did not retain cancellation/interruption outcomes")
	}
	if len(d.started) != 0 || activeCount(t, m) != 0 {
		t.Fatal("journal recovery or late dispatch reran an attempt")
	}
}

func TestM2TimeoutCleanupFailureRetainsSlot(t *testing.T) {
	m, d, ctx := lifecycleManager(t, 1)
	dispatch := dispatchForTest()
	task := d.add(dispatch)
	task.failFirst = true
	_ = m.accept(ctx, dispatch)
	awaitAttempt(t, d.started, dispatch.AttemptID)
	task.finish <- execution{ExitCode: -1, TimedOut: true, Error: "simulated watchdog deadline"}
	awaitAttempt(t, d.removing, dispatch.AttemptID)
	if activeCount(t, m) != 1 || journalRecord(m, dispatch.AttemptID).Phase == "complete" {
		t.Fatal("failed cleanup released a timed-out attempt")
	}
	awaitAttempt(t, d.removing, dispatch.AttemptID) // production cleanup retry, no fake clock
	close(task.reclaim)
	m.wg.Wait()
	r := journalRecord(m, dispatch.AttemptID)
	if r.Result.Status != "timed_out" || !r.Reclaimed || activeCount(t, m) != 0 {
		t.Fatalf("invalid timeout completion: %+v", r)
	}
}

func TestM2MaxWorkersConfiguration(t *testing.T) {
	for key, value := range map[string]string{"SERVER_URL": "http://server.invalid", "MANAGER_TOKEN": "synthetic", "MANAGER_ID": "manager-test", "WORKER_IMAGE": "fixture", "WHIPPET_WORKER_IMAGE": "", "WORK_DIR": t.TempDir()} {
		t.Setenv(key, value)
	}
	for _, value := range []string{"1", "2", "0", "-1", "invalid"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("MAX_WORKERS", value)
			cfg, err := LoadConfig()
			valid := value == "1" || value == "2"
			if (err == nil) != valid || valid && cfg.MaxWorkers < 1 {
				t.Fatalf("MAX_WORKERS=%s: cfg=%+v err=%v", value, cfg, err)
			}
		})
	}
}
