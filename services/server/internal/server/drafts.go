package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const MaxScriptBytes = 2 << 20
const defaultTimeoutMS = 60000

type draftState struct {
	Draft
	hash      string
	timeoutMS int
}

type validationEvidence struct {
	id, testID, kind, status string
	revision                 int
	script, hash             string
	timeoutMS                int
	reportReady              bool
}

func scriptHash(script string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(script))) }

func checkRevision(expected, current int) error {
	if expected < 1 {
		return fmt.Errorf("%w: revision must be positive", ErrInvalid)
	}
	if expected != current {
		return fmt.Errorf("%w: draft revision changed; reload the current draft", ErrConflict)
	}
	return nil
}

func checkPublication(revision int, confirmed bool, d draftState, v validationEvidence) error {
	if !confirmed {
		return fmt.Errorf("%w: confirmed must be true", ErrInvalid)
	}
	if err := checkRevision(revision, d.Revision); err != nil {
		return err
	}
	if d.ValidationRunID == nil || *d.ValidationRunID != v.id || v.testID != d.TestID ||
		v.kind != "validation" || v.revision != d.Revision || v.script != d.Script ||
		v.hash != d.hash || d.hash != scriptHash(d.Script) || v.timeoutMS != d.timeoutMS {
		return fmt.Errorf("%w: validation must match the current draft snapshot", ErrConflict)
	}
	if v.status != "succeeded" {
		return fmt.Errorf("%w: current revision has not passed validation", ErrConflict)
	}
	if !v.reportReady {
		return fmt.Errorf("%w: validation report is not saved or readable", ErrConflict)
	}
	return nil
}

func (p *Postgres) CreateTest(ctx context.Context, workspaceID, name, description string) (Test, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 200 || len(description) > 16<<10 {
		return Test{}, fmt.Errorf("%w: name is required (max 200 bytes); description max 16 KiB", ErrInvalid)
	}
	return scanTest(p.DB.QueryRowContext(ctx, `INSERT INTO tests(id,workspace_id,name,description)
        SELECT $1,id,$3,$4 FROM workspaces WHERE id=$2 RETURNING `+testColumns,
		NewID(), workspaceID, name, description))
}

const draftSelect = `SELECT d.test_id,d.current_revision,dr.script,d.updated_at,d.validation_run_id,
    COALESCE(r.status,''),CASE WHEN EXISTS (SELECT 1 FROM artifacts a
        WHERE a.run_id=r.id AND a.attempt_id=r.attempt_id AND a.name='report.html')
    THEN '/api/runs/' || r.id::text || '/artifacts/report.html' ELSE '' END,
    dr.script_hash,dr.timeout_ms
    FROM drafts d JOIN draft_revisions dr ON dr.test_id=d.test_id AND dr.revision=d.current_revision
    LEFT JOIN runs r ON r.id=d.validation_run_id WHERE d.test_id=$1`

func scanDraft(row scanner) (draftState, error) {
	var d draftState
	err := row.Scan(&d.TestID, &d.Revision, &d.Script, &d.UpdatedAt, &d.ValidationRunID,
		&d.ValidationStatus, &d.ReportURL, &d.hash, &d.timeoutMS)
	d.UpdatedAt = d.UpdatedAt.UTC()
	return d, dbError(err)
}

// All draft writers acquire this Test row first. Initialization, saves, validation,
// and publication therefore share one lock order and cannot bypass optimistic locks.
func lockDraft(ctx context.Context, tx *sql.Tx, testID string) (draftState, error) {
	var lockedID string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM tests WHERE id=$1 FOR UPDATE`, testID).Scan(&lockedID); err != nil {
		return draftState{}, dbError(err)
	}
	d, err := scanDraft(tx.QueryRowContext(ctx, draftSelect+` FOR UPDATE OF d`, testID))
	if err == nil || !errors.Is(err, ErrNotFound) {
		return d, err
	}
	var script string
	var timeoutMS int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(v.script,''),COALESCE(v.timeout_ms,$2)
        FROM tests t LEFT JOIN test_versions v ON v.id=t.published_version_id WHERE t.id=$1`, testID, defaultTimeoutMS).
		Scan(&script, &timeoutMS); err != nil {
		return draftState{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms)
        VALUES($1,1,$2,$3,$4)`, testID, script, scriptHash(script), timeoutMS); err != nil {
		return draftState{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO drafts(test_id,current_revision) VALUES($1,1)`, testID); err != nil {
		return draftState{}, err
	}
	return scanDraft(tx.QueryRowContext(ctx, draftSelect, testID))
}

func (p *Postgres) Draft(ctx context.Context, testID string) (Draft, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Draft{}, err
	}
	defer tx.Rollback()
	d, err := lockDraft(ctx, tx, testID)
	if err != nil {
		return Draft{}, err
	}
	if err := tx.Commit(); err != nil {
		return Draft{}, err
	}
	return d.Draft, nil
}

func (p *Postgres) SaveDraft(ctx context.Context, testID string, revision int, script string) (Draft, error) {
	if len(script) > MaxScriptBytes {
		return Draft{}, fmt.Errorf("%w: script exceeds 2 MiB", ErrInvalid)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Draft{}, err
	}
	defer tx.Rollback()
	d, err := lockDraft(ctx, tx, testID)
	if err != nil {
		return Draft{}, err
	}
	if err := checkRevision(revision, d.Revision); err != nil {
		return Draft{}, err
	}
	d, err = saveDraftScript(ctx, tx, d, script)
	if err != nil {
		return Draft{}, err
	}
	if err := tx.Commit(); err != nil {
		return Draft{}, err
	}
	return d.Draft, nil
}

// Caller holds the Test/Draft locks and has checked the expected revision.
func saveDraftScript(ctx context.Context, tx *sql.Tx, d draftState, script string) (draftState, error) {
	if script == d.Script {
		return d, nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms)
            VALUES($1,$2,$3,$4,$5)`, d.TestID, d.Revision+1, script, scriptHash(script), d.timeoutMS); err != nil {
		return draftState{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE drafts SET current_revision=current_revision+1,
            validation_run_id=NULL,updated_at=now() WHERE test_id=$1`, d.TestID); err != nil {
		return draftState{}, err
	}
	return scanDraft(tx.QueryRowContext(ctx, draftSelect, d.TestID))
}

func (p *Postgres) ValidateDraft(ctx context.Context, testID string, revision int) (Run, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	d, err := lockDraft(ctx, tx, testID)
	if err != nil {
		return Run{}, err
	}
	if err := checkRevision(revision, d.Revision); err != nil {
		return Run{}, err
	}
	if strings.TrimSpace(d.Script) == "" {
		return Run{}, fmt.Errorf("%w: save a non-empty script before validation", ErrInvalid)
	}
	r, err := enqueueValidation(ctx, tx, d)
	if err != nil {
		return Run{}, err
	}
	if err := tx.Commit(); err != nil {
		return Run{}, err
	}
	return r, nil
}

// Reused by author completion; this inserts queued work and never waits for its slot.
func enqueueValidation(ctx context.Context, tx *sql.Tx, d draftState) (Run, error) {
	id := NewID()
	if _, err := tx.ExecContext(ctx, `INSERT INTO runs(id,test_id,kind,draft_revision,script_snapshot,script_hash,timeout_ms)
        VALUES($1,$2,'validation',$3,$4,$5,$6)`, id, d.TestID, d.Revision, d.Script, d.hash, d.timeoutMS); err != nil {
		return Run{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE drafts SET validation_run_id=$2,updated_at=now() WHERE test_id=$1`, d.TestID, id); err != nil {
		return Run{}, err
	}
	return scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, id))
}

const versionColumns = `id,test_id,source_revision,script,created_at,validation_run_id`

func scanVersion(row scanner) (Version, error) {
	var v Version
	err := row.Scan(&v.ID, &v.TestID, &v.Revision, &v.Script, &v.CreatedAt, &v.ValidationRunID)
	v.CreatedAt = v.CreatedAt.UTC()
	return v, dbError(err)
}

func (p *Postgres) Versions(ctx context.Context, testID string) ([]Version, error) {
	if _, err := p.Test(ctx, testID); err != nil {
		return nil, err
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT `+versionColumns+` FROM test_versions WHERE test_id=$1 ORDER BY version DESC`, testID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Version{}
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}

func (p *Postgres) Publish(ctx context.Context, testID string, revision int, confirmed bool) (Version, error) {
	if !confirmed {
		return Version{}, fmt.Errorf("%w: confirmed must be true", ErrInvalid)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Version{}, err
	}
	defer tx.Rollback()
	d, err := lockDraft(ctx, tx, testID)
	if err != nil {
		return Version{}, err
	}
	if err := checkRevision(revision, d.Revision); err != nil {
		return Version{}, err
	}
	if d.ValidationRunID == nil {
		return Version{}, fmt.Errorf("%w: current revision needs validation", ErrConflict)
	}
	var v validationEvidence
	var key sql.NullString
	var size sql.NullInt64
	err = tx.QueryRowContext(ctx, `SELECT r.id,r.test_id,r.kind,r.draft_revision,r.script_snapshot,
        COALESCE(r.script_hash,''),r.timeout_ms,r.status,a.storage_key,a.size_bytes
        FROM runs r LEFT JOIN artifacts a ON a.run_id=r.id AND a.attempt_id=r.attempt_id AND a.name='report.html'
        WHERE r.id=$1 FOR UPDATE OF r`, *d.ValidationRunID).Scan(
		&v.id, &v.testID, &v.kind, &v.revision, &v.script, &v.hash, &v.timeoutMS, &v.status, &key, &size)
	if err != nil {
		return Version{}, err
	}
	v.reportReady = p.reportReady(key, size)
	if err := checkPublication(revision, confirmed, d, v); err != nil {
		return Version{}, err
	}
	// Repeating the same confirmation returns the original immutable version.
	published, err := scanVersion(tx.QueryRowContext(ctx, `SELECT `+versionColumns+`
        FROM test_versions WHERE test_id=$1 AND validation_run_id=$2`, testID, v.id))
	if errors.Is(err, ErrNotFound) {
		published, err = scanVersion(tx.QueryRowContext(ctx, `INSERT INTO test_versions
            (id,test_id,version,source_revision,script,script_hash,timeout_ms,validation_run_id)
            SELECT $1,$2,COALESCE(MAX(version),0)+1,$3,$4,$5,$6,$7 FROM test_versions WHERE test_id=$2
            RETURNING `+versionColumns, NewID(), testID, d.Revision, d.Script, d.hash, d.timeoutMS, v.id))
	}
	if err != nil {
		return Version{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, testID, published.ID); err != nil {
		return Version{}, err
	}
	if err := tx.Commit(); err != nil {
		return Version{}, err
	}
	return published, nil
}

func (p *Postgres) reportReady(key sql.NullString, size sql.NullInt64) bool {
	if p.Artifacts == nil || !key.Valid || !size.Valid || size.Int64 <= 0 {
		return false
	}
	f, err := p.Artifacts.Open(key.String)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	return err == nil && info.Mode().IsRegular() && info.Size() == size.Int64
}
