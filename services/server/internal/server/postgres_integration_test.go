//go:build integration

package server

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

// Explicit opt-in: creates and removes its own schema in an existing test database.
func TestPostgresQueueAndAttemptInvariants(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a disposable PostgreSQL database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		t.Fatal("TEST_DATABASE_URL must be a PostgreSQL URL")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := "whippet_test_" + strings.ReplaceAll(NewID(), "-", "")
	if _, err := admin.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if _, err := admin.ExecContext(cleanup, `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Errorf("remove test schema: %v", err)
		}
	}()
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	db, err := sql.Open("postgres", u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	p := &Postgres{DB: db}
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.Migrate(ctx); err != nil {
		t.Fatalf("idempotent migration: %v", err)
	}
	workspaces, err := p.Workspaces(ctx)
	if err != nil || len(workspaces) != 1 {
		t.Fatalf("seed workspace: %+v %v", workspaces, err)
	}
	tests, err := p.Tests(ctx, workspaces[0].ID)
	if err != nil || len(tests) != 2 || tests[0].PublishedVersionID == nil {
		t.Fatalf("seed tests: %+v %v", tests, err)
	}
	first, err := p.CreateRun(ctx, tests[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := p.CreateRun(ctx, tests[1].ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.RegisterManager(ctx, "integration-manager", 1); err != nil {
		t.Fatal(err)
	}
	if err := p.RegisterManager(ctx, "other-manager", 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("second Manager must be rejected: %v", err)
	}
	a, err := p.Claim(ctx, "integration-manager", 1)
	if err != nil || a == nil || a.ID != first.ID || !strings.Contains(a.Script, "page.setContent") {
		t.Fatalf("FIFO immutable snapshot: %+v %v", a, err)
	}
	blocked, err := p.Claim(ctx, "integration-manager", 1)
	if err != nil || blocked != nil {
		t.Fatalf("capacity exceeded: %+v %v", blocked, err)
	}
	if err := p.Complete(ctx, a.ManagerID, a.ID, NewID(), Result{Status: "failed"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale attempt accepted: %v", err)
	}
	if err := p.Complete(ctx, a.ManagerID, a.ID, a.AttemptID, Result{Status: "succeeded"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("success without reports accepted: %v", err)
	}
	event := Event{NewID(), "started", "started"}
	for i := 0; i < 2; i++ {
		if err := p.AddEvent(ctx, a.ManagerID, a.ID, a.AttemptID, event); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM run_events WHERE run_id=$1`, a.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("event dedup count=%d, %v", count, err)
	}
	for _, name := range []string{"report.html", "results.json"} {
		artifact := Artifact{RunID: a.ID, AttemptID: a.AttemptID, Name: name, StorageKey: "test-key", Size: 1, SHA256: "test-hash"}
		if err := p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatal(err)
		}
		if err := p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatalf("idempotent artifact retry: %v", err)
		}
		artifact.SHA256 = "conflicting-hash"
		if err := p.SaveArtifact(ctx, artifact); !errors.Is(err, ErrConflict) {
			t.Fatalf("conflicting artifact overwrite accepted: %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := p.Complete(ctx, a.ManagerID, a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := p.Complete(ctx, a.ManagerID, a.ID, a.AttemptID, Result{Status: "failed"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("terminal result mutated: %v", err)
	}
	completed, err := p.Run(ctx, first.ID)
	if err != nil || completed.ReportURL == "" || completed.FinishedAt == nil {
		t.Fatalf("completed run: %+v %v", completed, err)
	}
	blocked, err = p.Claim(ctx, a.ManagerID, 1)
	if err != nil || blocked != nil {
		t.Fatal("completion released a slot before cleanup")
	}
	if err := p.ReleaseSlots(ctx, a.ManagerID, []ActiveAttempt{{a.ID, a.AttemptID}}); err != nil {
		t.Fatal(err)
	}
	blocked, err = p.Claim(ctx, a.ManagerID, 1)
	if err != nil || blocked != nil {
		t.Fatal("active terminal Worker released its slot")
	}
	if err := p.ReleaseSlots(ctx, a.ManagerID, nil); err != nil {
		t.Fatal(err)
	}
	b, err := p.Claim(ctx, a.ManagerID, 1)
	if err != nil || b == nil || b.ID != second.ID {
		t.Fatalf("next task not dispatched: %+v %v", b, err)
	}
	if cancelled, err := p.Cancel(ctx, second.ID); err != nil || cancelled.Status != "cancelling" {
		t.Fatalf("active cancellation: %+v %v", cancelled, err)
	}
}
