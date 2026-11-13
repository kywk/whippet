package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/whippet/whippet/services/server/migrations"
)

type Postgres struct {
	DB            *sql.DB
	Artifacts     ArtifactStorage
	Secrets       *SecretVault
	CredentialTLS bool
}

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
	rows, err := p.DB.QueryContext(ctx, `SELECT id FROM workspaces ORDER BY id`)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	items := []Workspace{}
	for _, id := range ids {
		w, err := p.Workspace(ctx, id)
		if err != nil {
			return nil, err
		}
		items = append(items, w)
	}
	return items, nil
}

const testColumns = `id,workspace_id,name,description,published_version_id,
 (SELECT json_build_object('id',e.id,'status',e.status,'draftRevision',d.current_revision,'updatedAt',d.updated_at)
  FROM editing_sessions e JOIN drafts d ON d.editing_session_id=e.id
  WHERE e.test_id=tests.id AND e.status IN ('active','discarding'))`

type scanner interface{ Scan(...any) error }

func scanTest(row scanner) (Test, error) {
	var t Test
	var active []byte
	err := row.Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Description, &t.PublishedVersionID, &active)
	if err == nil && len(active) > 0 {
		err = json.Unmarshal(active, &t.ActiveEditingSession)
	}
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
    THEN '/api/runs/' || r.id::text || '/artifacts/report.html' ELSE '' END,
    r.kind,r.draft_revision,r.version_id,r.workspace_settings,r.editing_session_id,r.workspace_id,r.workspace_context,
    CASE WHEN r.kind='author' THEN CASE WHEN r.author_payload->>'skillId'='acceptance-summary' THEN 'summary' WHEN r.author_payload->>'skillId'='workspace-author' THEN 'workspace' ELSE 'edit' END ELSE '' END,r.script_origin,r.authorization_revision,r.scope_proposal_id,
    CASE WHEN r.kind='author' AND r.attempt_id IS NOT NULL THEN COALESCE((SELECT jsonb_agg(e.message ORDER BY e.created_at) FROM run_events e WHERE e.run_id=r.id AND e.attempt_id=r.attempt_id AND e.kind='log'),'[]'::jsonb) ELSE '[]'::jsonb END`

func scanRun(row scanner) (Run, error) {
	var r Run
	var settings, workspaceContext, progressEvents []byte
	err := row.Scan(&r.ID, &r.TestID, &r.Status, &r.CreatedAt, &r.StartedAt, &r.FinishedAt, &r.Error, &r.ReportURL, &r.Kind, &r.DraftRevision, &r.VersionID, &settings, &r.EditingSessionID, &r.WorkspaceID, &workspaceContext, &r.AuthorMode, &r.ScriptOrigin, &r.authorizationRevision, &r.scopeProposalID, &progressEvents)
	if err == nil {
		r.WorkspaceSettings, err = decodeSettings(settings)
		if err == nil {
			r.WorkspaceContext, err = decodeWorkspaceContext(workspaceContext)
		}
		if err == nil && len(progressEvents) > 0 {
			_ = json.Unmarshal(progressEvents, &r.ProgressEvents)
		}
	}
	r.CreatedAt = r.CreatedAt.UTC()
	return r, dbError(err)
}

func (p *Postgres) CreateRun(ctx context.Context, testID string) (Run, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	if _, err = lockEditingTest(ctx, tx, testID); err != nil {
		return Run{}, err
	}
	v, err := scanVersion(tx.QueryRowContext(ctx, `SELECT `+versionColumns+` FROM test_versions WHERE id=(SELECT published_version_id FROM tests WHERE id=$1)`, testID))
	if err != nil {
		if err == ErrNotFound {
			return Run{}, ErrConflict
		}
		return Run{}, err
	}
	w, err := workspaceForTest(ctx, tx, testID)
	if err != nil {
		return Run{}, err
	}
	snapshot := v.WorkspaceContext
	if v.ScriptOrigin == "legacy" && (snapshot == nil || snapshot.Config == nil) {
		snapshot, _ = selectedContext(w, false)
	}
	auth, proposal, err := executionBinding(w, v.ScriptOrigin, snapshot)
	if err != nil {
		return Run{}, err
	}
	id := NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO runs(id,test_id,workspace_id,version_id,script_snapshot,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,authorization_revision,scope_proposal_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, id, testID, w.ID, v.ID, v.Script, scriptHash(v.Script), v.WorkspaceSettings.TimeoutMS, settingsJSON(v.WorkspaceSettings), jsonText(snapshot), v.ScriptOrigin, auth, proposal); err != nil {
		return Run{}, err
	}
	run, err := scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, id))
	if err != nil {
		return run, err
	}
	if err = tx.Commit(); err != nil {
		return run, err
	}
	return run, nil
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
	if err := p.rejectUnsafeWork(ctx); err != nil {
		return nil, err
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT r.id,r.status,r.attempt_id,r.script_snapshot,r.timeout_ms,r.acknowledged_at IS NOT NULL,r.kind,COALESCE(r.author_payload::text,''),r.workspace_settings,r.workspace_id,r.test_id,r.workspace_context,r.script_origin,r.authorization_revision,r.scope_proposal_id
        FROM runs r WHERE r.manager_id=$1 AND NOT r.slot_released ORDER BY r.queue_seq`, managerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Assignment{}
	for rows.Next() {
		a := Assignment{ManagerID: managerID}
		var authorPayload string
		var settings, context []byte
		if err := rows.Scan(&a.ID, &a.Status, &a.AttemptID, &a.Script, &a.TimeoutMS, &a.Acked, &a.Kind, &authorPayload, &settings, &a.WorkspaceID, &a.TestID, &context, &a.ScriptOrigin, &a.authorizationRevision, &a.scopeProposalID); err != nil {
			return nil, err
		}
		a.WorkspaceSettings, err = decodeSettings(settings)
		if err == nil {
			a.WorkspaceContext, err = decodeWorkspaceContext(context)
		}
		if err != nil {
			return nil, err
		}
		if err := decodeAssignmentAuthor(&a, authorPayload); err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for i := range items {
		if permissionErr := p.assignmentAllowed(ctx, p.DB, items[i]); permissionErr != nil {
			if permissionErr != ErrScopeConfirmation {
				return nil, permissionErr
			}
			if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelling',error='scope_confirmation_required' WHERE id=$1 AND status IN ('dispatched','running','collecting')`, items[i].ID); err != nil {
				return nil, err
			}
			if !Terminal(items[i].Status) {
				items[i].Status = "cancelling"
			}
		}
	}
	return items, nil
}

func (p *Postgres) Claim(ctx context.Context, managerID string, capacity int) (*Assignment, error) {
	if err := p.rejectUnsafeWork(ctx); err != nil {
		return nil, err
	}
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
	var authorPayload string
	var settings, context []byte
	err = tx.QueryRowContext(ctx, `SELECT id,script_snapshot,timeout_ms,kind,COALESCE(author_payload::text,''),workspace_settings,workspace_id,test_id,workspace_context,script_origin,authorization_revision,scope_proposal_id FROM runs
        WHERE status='queued' ORDER BY queue_seq FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&a.ID, &a.Script, &a.TimeoutMS, &a.Kind, &authorPayload, &settings, &a.WorkspaceID, &a.TestID, &context, &a.ScriptOrigin, &a.authorizationRevision, &a.scopeProposalID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.WorkspaceSettings, err = decodeSettings(settings)
	if err == nil {
		a.WorkspaceContext, err = decodeWorkspaceContext(context)
	}
	if err != nil {
		return nil, err
	}
	if err := decodeAssignmentAuthor(&a, authorPayload); err != nil {
		return nil, err
	}
	if permissionErr := p.assignmentAllowed(ctx, tx, a); permissionErr != nil {
		if permissionErr != ErrScopeConfirmation {
			return nil, permissionErr
		}
		if _, err := tx.ExecContext(ctx, `UPDATE runs SET status='failed',error='scope_confirmation_required',finished_at=now() WHERE id=$1`, a.ID); err != nil {
			return nil, err
		}
		return nil, tx.Commit()
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

func decodeAssignmentAuthor(a *Assignment, payload string) error {
	if a.Kind != "author" {
		return nil
	}
	var input AuthorInput
	if json.Unmarshal([]byte(payload), &input) != nil || !ValidID(input.ConversationID) || input.BaseRevision < 1 {
		return fmt.Errorf("invalid author input snapshot")
	}
	a.Author = &input
	return nil
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
	var kind, workspaceID string
	var testID *string
	if err := p.DB.QueryRowContext(ctx, `SELECT kind,test_id,workspace_id FROM runs WHERE id=$1 AND manager_id=$2 AND attempt_id=$3`,
		runID, managerID, attemptID).Scan(&kind, &testID, &workspaceID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrConflict
		}
		return err
	}
	if kind == "author" {
		if testID == nil {
			return p.completeWorkspaceAuthor(ctx, workspaceID, managerID, runID, attemptID, result)
		}
		return p.completeAuthor(ctx, *testID, managerID, runID, attemptID, result)
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
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM artifacts WHERE run_id=$1 AND attempt_id=$2 AND name IN ('report.html','results.json')`, runID, attemptID).Scan(&count); err != nil {
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

func (p *Postgres) UploadAllowed(ctx context.Context, runID, attemptID, name string) error {
	var status, kind string
	err := p.DB.QueryRowContext(ctx, `SELECT status,kind FROM runs WHERE id=$1 AND attempt_id=$2`, runID, attemptID).Scan(&status, &kind)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrConflict
		}
		return err
	}
	if Terminal(status) {
		return fmt.Errorf("%w: run is terminal", ErrConflict)
	}
	if !artifactAllowed(kind, name) {
		return fmt.Errorf("%w: artifact name does not match run kind", ErrInvalid)
	}
	return nil
}

func (p *Postgres) SaveArtifact(ctx context.Context, a Artifact) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status, kind string
	if err := tx.QueryRowContext(ctx, `SELECT status,kind FROM runs WHERE id=$1 AND attempt_id=$2 FOR UPDATE`, a.RunID, a.AttemptID).Scan(&status, &kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrConflict
		}
		return err
	}
	if Terminal(status) {
		return ErrConflict
	}
	if !artifactAllowed(kind, a.Name) || a.Size < 0 || a.Size > artifactLimit(a.Name) {
		return fmt.Errorf("%w: invalid artifact for run kind", ErrInvalid)
	}
	if isScreenshotArtifact(a.Name) {
		// The Run row remains locked, serializing the quota check with all uploads.
		// Exclude this name so an identical upload retry does not consume another slot.
		var count, total int64
		if err := tx.QueryRowContext(ctx, `SELECT count(*),COALESCE(sum(size_bytes),0) FROM artifacts
            WHERE run_id=$1 AND name ~ '^data/[0-9a-f]{40}[.]png$' AND name<>$2`, a.RunID, a.Name).Scan(&count, &total); err != nil {
			return err
		}
		if err := checkScreenshotQuota(count, total, a.Size); err != nil {
			return err
		}
	}
	if isEvidenceArtifact(a.Name) {
		var count, total int64
		if err := tx.QueryRowContext(ctx, `SELECT count(*),COALESCE(sum(size_bytes),0) FROM artifacts
            WHERE run_id=$1 AND name ~ '^data/[0-9a-f]{40}[.](zip|md)$' AND name<>$2`, a.RunID, a.Name).Scan(&count, &total); err != nil {
			return err
		}
		if err := checkEvidenceQuota(count, total, a.Size); err != nil {
			return err
		}
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
	var kind string
	if err := p.DB.QueryRowContext(ctx, `SELECT kind FROM runs WHERE id=$1`, runID).Scan(&kind); err != nil {
		return a, dbError(err)
	}
	if !artifactAllowed(kind, name) {
		return a, fmt.Errorf("%w: artifact name does not match run kind", ErrInvalid)
	}
	err := p.DB.QueryRowContext(ctx, `SELECT a.attempt_id,a.storage_key,a.size_bytes,a.sha256 FROM artifacts a
        JOIN runs r ON r.id=a.run_id AND r.attempt_id=a.attempt_id WHERE a.run_id=$1 AND a.name=$2`, runID, name).
		Scan(&a.AttemptID, &a.StorageKey, &a.Size, &a.SHA256)
	return a, dbError(err)
}

func (p *Postgres) ListArtifacts(ctx context.Context, runID string) ([]ArtifactInfo, error) {
	// LEFT JOIN distinguishes an unknown Run from a known Run with no saved
	// attachments, and never returns another attempt's metadata or storage paths.
	rows, err := p.DB.QueryContext(ctx, `SELECT r.kind,a.name,a.size_bytes FROM runs r
        LEFT JOIN artifacts a ON a.run_id=r.id AND a.attempt_id=r.attempt_id
        WHERE r.id=$1 ORDER BY a.name`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ArtifactInfo{}
	found := false
	for rows.Next() {
		found = true
		var kind string
		var name sql.NullString
		var size sql.NullInt64
		if err := rows.Scan(&kind, &name, &size); err != nil {
			return nil, err
		}
		if name.Valid && artifactAllowed(kind, name.String) {
			items = append(items, ArtifactInfo{Name: name.String, Size: size.Int64, ContentType: artifactContentType(name.String),
				URL: "/api/runs/" + runID + "/artifacts/" + name.String})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrNotFound
	}
	return items, nil
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
