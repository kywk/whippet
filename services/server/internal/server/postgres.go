package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/whippet/whippet/services/server/migrations"
)

type Postgres struct{ DB *sql.DB }

// Migrate serializes startup migrations and records each file in the same transaction.
func (p *Postgres) Migrate(ctx context.Context) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(81742601)`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		var applied bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name=$1)`, entry.Name()).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		body, readErr := migrations.Files.ReadFile(entry.Name())
		if readErr != nil {
			return readErr
		}
		if _, err = tx.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO schema_migrations(name) VALUES ($1)`, entry.Name()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (p *Postgres) Ping(ctx context.Context) error { return p.DB.PingContext(ctx) }

func (p *Postgres) Workspaces(ctx context.Context) ([]Workspace, error) {
	rows, err := p.DB.QueryContext(ctx, `SELECT id,name FROM workspaces ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Workspace{}
	for rows.Next() {
		var w Workspace
		if err := rows.Scan(&w.ID, &w.Name); err != nil {
			return nil, err
		}
		items = append(items, w)
	}
	return items, rows.Err()
}

const testColumns = `id,workspace_id,name,description,published_version_id`

type scanner interface{ Scan(...any) error }

func scanTest(row scanner) (Test, error) {
	var t Test
	err := row.Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Description, &t.PublishedVersionID)
	return t, dbError(err)
}

func (p *Postgres) Tests(ctx context.Context, workspaceID string) ([]Test, error) {
	var exists bool
	if err := p.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)`, workspaceID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT `+testColumns+` FROM tests WHERE workspace_id=$1 ORDER BY id`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Test{}
	for rows.Next() {
		t, err := scanTest(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

func (p *Postgres) Test(ctx context.Context, id string) (Test, error) {
	return scanTest(p.DB.QueryRowContext(ctx, `SELECT `+testColumns+` FROM tests WHERE id=$1`, id))
}

const runColumns = `r.id,r.test_id,r.status,r.created_at,r.started_at,r.finished_at,r.error,
    CASE WHEN EXISTS(SELECT 1 FROM artifacts a WHERE a.run_id=r.id AND a.attempt_id=r.attempt_id AND a.name='report.html')
    THEN '/api/runs/' || r.id::text || '/artifacts/report.html' ELSE '' END`

func scanRun(row scanner) (Run, error) {
	var r Run
	err := row.Scan(&r.ID, &r.TestID, &r.Status, &r.CreatedAt, &r.StartedAt, &r.FinishedAt, &r.Error, &r.ReportURL)
	r.CreatedAt = r.CreatedAt.UTC()
	return r, dbError(err)
}

func (p *Postgres) CreateRun(ctx context.Context, testID string) (Run, error) {
	// INSERT ... SELECT freezes the published version and its script in one statement.
	id := NewID()
	res, err := p.DB.ExecContext(ctx, `INSERT INTO runs(id,test_id,version_id,script_snapshot,timeout_ms)
        SELECT $1,t.id,v.id,v.script,v.timeout_ms FROM tests t
        JOIN test_versions v ON v.id=t.published_version_id AND v.test_id=t.id WHERE t.id=$2`, id, testID)
	if err != nil {
		return Run{}, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return Run{}, err
	}
	if n == 0 {
		if _, err := p.Test(ctx, testID); err != nil {
			return Run{}, err
		}
		return Run{}, fmt.Errorf("%w: test has no published version", ErrConflict)
	}
	return p.Run(ctx, id)
}

func (p *Postgres) Runs(ctx context.Context, testID string) ([]Run, error) {
	if _, err := p.Test(ctx, testID); err != nil {
		return nil, err
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.test_id=$1 ORDER BY r.queue_seq DESC`, testID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Run{}
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, r)
	}
	return items, rows.Err()
}

func (p *Postgres) Run(ctx context.Context, id string) (Run, error) {
	return scanRun(p.DB.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, id))
}

func (p *Postgres) Cancel(ctx context.Context, id string) (Run, error) {
	_, err := p.DB.ExecContext(ctx, `UPDATE runs SET
        status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,
        finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END
        WHERE id=$1 AND status IN ('queued','dispatched','running','collecting')`, id)
	if err != nil {
		return Run{}, err
	}
	return p.Run(ctx, id)
}

func (p *Postgres) RegisterManager(ctx context.Context, id string, capacity int) error {
	res, err := p.DB.ExecContext(ctx, `INSERT INTO managers(singleton,id,capacity) VALUES (true,$1,$2)
        ON CONFLICT (singleton) DO UPDATE SET capacity=EXCLUDED.capacity,last_seen_at=now()
        WHERE managers.id=EXCLUDED.id`, id, capacity)
	return affected(res, err)
}

func (p *Postgres) Assignments(ctx context.Context, managerID string) ([]Assignment, error) {
	rows, err := p.DB.QueryContext(ctx, `SELECT r.id,r.status,r.attempt_id,r.script_snapshot,r.timeout_ms,r.acknowledged_at IS NOT NULL
        FROM runs r WHERE r.manager_id=$1 AND NOT r.slot_released ORDER BY r.queue_seq`, managerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Assignment{}
	for rows.Next() {
		a := Assignment{ManagerID: managerID}
		if err := rows.Scan(&a.ID, &a.Status, &a.AttemptID, &a.Script, &a.TimeoutMS, &a.Acked); err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}

func (p *Postgres) Claim(ctx context.Context, managerID string, capacity int) (*Assignment, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var persistedCapacity int
	if err := tx.QueryRowContext(ctx, `SELECT capacity FROM managers WHERE id=$1 FOR UPDATE`, managerID).Scan(&persistedCapacity); err != nil {
		return nil, dbError(err)
	}
	if persistedCapacity < capacity {
		capacity = persistedCapacity
	}
	var occupied int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE manager_id=$1 AND NOT slot_released`, managerID).Scan(&occupied); err != nil {
		return nil, err
	}
	if occupied >= capacity {
		return nil, nil
	}
	a := Assignment{ManagerID: managerID, AttemptID: NewID()}
	err = tx.QueryRowContext(ctx, `SELECT id,script_snapshot,timeout_ms FROM runs
        WHERE status='queued' ORDER BY queue_seq FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&a.ID, &a.Script, &a.TimeoutMS)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET status='dispatched',manager_id=$2,attempt_id=$3,slot_released=false WHERE id=$1`, a.ID, managerID, a.AttemptID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	a.Status = "dispatched"
	return &a, nil
}

func (p *Postgres) Acknowledge(ctx context.Context, managerID, runID, attemptID string) error {
	res, err := p.DB.ExecContext(ctx, `UPDATE runs SET acknowledged_at=COALESCE(acknowledged_at,now())
        WHERE id=$1 AND manager_id=$2 AND attempt_id=$3`, runID, managerID, attemptID)
	return affected(res, err)
}

func lockAttempt(ctx context.Context, tx *sql.Tx, managerID, runID, attemptID string) (string, error) {
	var status string
	err := tx.QueryRowContext(ctx, `SELECT status FROM runs WHERE id=$1 AND manager_id=$2 AND attempt_id=$3 FOR UPDATE`, runID, managerID, attemptID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrConflict
	}
	return status, err
}

func (p *Postgres) AddEvent(ctx context.Context, managerID, runID, attemptID string, event Event) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	status, err := lockAttempt(ctx, tx, managerID, runID, attemptID)
	if err != nil {
		return err
	}
	if Terminal(status) {
		return nil
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO run_events(run_id,event_id,attempt_id,kind,message)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, runID, event.EventID, attemptID, event.Kind, event.Message)
	if err != nil {
		return err
	}
	inserted, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if inserted > 0 && event.Kind == "started" {
		if _, err := tx.ExecContext(ctx, `UPDATE runs SET
            status=CASE WHEN status='dispatched' THEN 'running' ELSE status END,
            started_at=COALESCE(started_at,now()),acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1`, runID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (p *Postgres) Complete(ctx context.Context, managerID, runID, attemptID string, result Result) error {
	if !result.Valid() {
		return ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	status, err := lockAttempt(ctx, tx, managerID, runID, attemptID)
	if err != nil {
		return err
	}
	if Terminal(status) {
		if status != result.Status {
			return fmt.Errorf("%w: terminal result is immutable", ErrConflict)
		}
		return nil
	}
	if result.Status == "succeeded" {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM artifacts WHERE run_id=$1 AND attempt_id=$2`, runID, attemptID).Scan(&count); err != nil {
			return err
		}
		if count != 2 {
			return fmt.Errorf("%w: successful result requires report.html and results.json", ErrConflict)
		}
	}
	// Result finalizes the Run, but heartbeat must confirm slot reclamation separately.
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET status=$2,error=$3,finished_at=now(),
        acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1`, runID, result.Status, result.Error); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *Postgres) ReleaseSlots(ctx context.Context, managerID string, active []ActiveAttempt) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE managers SET last_seen_at=now() WHERE id=$1`, managerID); err != nil {
		return err
	}
	// Only terminal runs absent from the authoritative active list can free a slot.
	query := `UPDATE runs SET slot_released=true WHERE manager_id=$1 AND NOT slot_released
        AND status IN ('succeeded','failed','cancelled','timed_out','interrupted')`
	args := []any{managerID}
	for _, a := range active {
		args = append(args, a.RunID, a.AttemptID)
		query += fmt.Sprintf(" AND NOT (id=$%d AND attempt_id=$%d)", len(args)-1, len(args))
	}
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *Postgres) UploadAllowed(ctx context.Context, runID, attemptID string) error {
	var status string
	err := p.DB.QueryRowContext(ctx, `SELECT status FROM runs WHERE id=$1 AND attempt_id=$2`, runID, attemptID).Scan(&status)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrConflict
		}
		return err
	}
	if Terminal(status) {
		return fmt.Errorf("%w: run is terminal", ErrConflict)
	}
	return nil
}

func (p *Postgres) SaveArtifact(ctx context.Context, a Artifact) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	if err := tx.QueryRowContext(ctx, `SELECT status FROM runs WHERE id=$1 AND attempt_id=$2 FOR UPDATE`, a.RunID, a.AttemptID).Scan(&status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrConflict
		}
		return err
	}
	if Terminal(status) {
		return ErrConflict
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO artifacts(run_id,name,attempt_id,storage_key,size_bytes,sha256)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id,name) DO UPDATE SET uploaded_at=artifacts.uploaded_at
        WHERE artifacts.attempt_id=EXCLUDED.attempt_id AND artifacts.sha256=EXCLUDED.sha256`,
		a.RunID, a.Name, a.AttemptID, a.StorageKey, a.Size, a.SHA256)
	if err := affected(res, err); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET status='collecting' WHERE id=$1 AND status IN ('dispatched','running')`, a.RunID); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *Postgres) Artifact(ctx context.Context, runID, name string) (Artifact, error) {
	a := Artifact{RunID: runID, Name: name}
	err := p.DB.QueryRowContext(ctx, `SELECT a.attempt_id,a.storage_key,a.size_bytes,a.sha256 FROM artifacts a
        JOIN runs r ON r.id=a.run_id AND r.attempt_id=a.attempt_id WHERE a.run_id=$1 AND a.name=$2`, runID, name).
		Scan(&a.AttemptID, &a.StorageKey, &a.Size, &a.SHA256)
	return a, dbError(err)
}

func affected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrConflict
	}
	return nil
}

func dbError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
