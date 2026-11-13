package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

const MaxScriptBytes = 2 << 20

type draftState struct {
	Draft
	hash               string
	timeoutMS          int
	summaryRunID       *string
	summaryDescription *string
	summaryBackground  *string
	summaryName        *string
}

type validationEvidence struct {
	bundle                   *RunBundle
	expectedBundle           *RunBundle
	id, testID, kind, status string
	revision                 int
	script, hash             string
	timeoutMS                int
	reportReady              bool
	settings                 *WorkspaceSettings
	sessionID                *string
	attemptID                string
	workspaceContext         *WorkspaceContext
	scriptOrigin             string
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
	expectedScript, expectedOrigin := d.Script, d.ScriptOrigin
	if v.expectedBundle != nil {
		if v.bundle == nil {
			return ErrConflict
		}
		actual, err := v.bundle.hash()
		if err != nil {
			return ErrConflict
		}
		expected, err := v.expectedBundle.hash()
		if err != nil || actual != expected {
			return ErrConflict
		}
		expectedScript, expectedOrigin = v.expectedBundle.entry(), v.expectedBundle.origin()
	} else if v.bundle != nil {
		return ErrConflict
	}
	if d.ValidationRunID == nil || *d.ValidationRunID != v.id || v.testID != d.TestID ||
		v.kind != "validation" || v.revision != d.Revision || v.script != expectedScript ||
		v.hash != scriptHash(expectedScript) || d.hash != scriptHash(d.Script) || v.timeoutMS != d.timeoutMS ||
		d.WorkspaceSettings == nil || v.settings == nil || d.WorkspaceSettings.TimeoutMS != d.timeoutMS ||
		effectiveScriptOrigin(expectedOrigin) != effectiveScriptOrigin(v.scriptOrigin) || !sameWorkspaceSettings(d.WorkspaceSettings, v.settings) || !sameWorkspaceContext(d.WorkspaceContext, v.workspaceContext) || (d.EditingSessionID != "" && (v.sessionID == nil || *v.sessionID != d.EditingSessionID)) {
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
	if name == "" {
		name = "未命名測試"
	}
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
    dr.script_hash,dr.timeout_ms,dr.workspace_settings,d.editing_session_id,d.summary_run_id,d.summary_description,d.summary_background,d.summary_name,dr.workspace_context,dr.script_origin,COALESCE(dr.module,'null'::jsonb),dr.stages
    FROM drafts d JOIN draft_revisions dr ON dr.test_id=d.test_id AND dr.revision=d.current_revision
    LEFT JOIN runs r ON r.id=d.validation_run_id WHERE d.test_id=$1`

func scanDraft(row scanner) (draftState, error) {
	var d draftState
	var settings, context, module, stages []byte
	err := row.Scan(&d.TestID, &d.Revision, &d.Script, &d.UpdatedAt, &d.ValidationRunID,
		&d.ValidationStatus, &d.ReportURL, &d.hash, &d.timeoutMS, &settings, &d.EditingSessionID, &d.summaryRunID, &d.summaryDescription, &d.summaryBackground, &d.summaryName, &context, &d.ScriptOrigin, &module, &stages)
	if err == nil {
		d.WorkspaceSettings, err = decodeSettings(settings)
		if err == nil {
			d.WorkspaceContext, err = decodeWorkspaceContext(context)
		}
	}
	if err == nil {
		err = json.Unmarshal(module, &d.Module)
	}
	if err == nil {
		err = json.Unmarshal(stages, &d.Stages)
	}
	d.UpdatedAt = d.UpdatedAt.UTC()
	return d, dbError(err)
}

// Read-only: creation is exclusively StartEditingSession.
func (p *Postgres) Draft(ctx context.Context, testID string) (Draft, error) {
	d, err := scanDraft(p.DB.QueryRowContext(ctx, draftSelect+` AND EXISTS(SELECT 1 FROM editing_sessions e WHERE e.id=d.editing_session_id AND e.status IN ('active','discarding'))`, testID))
	return d.Draft, err
}

func (p *Postgres) SaveDraft(ctx context.Context, testID, sessionID string, revision int, script string) (Draft, error) {
	if len(script) > MaxScriptBytes {
		return Draft{}, fmt.Errorf("%w: script exceeds 2 MiB", ErrInvalid)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Draft{}, err
	}
	defer tx.Rollback()
	d, _, err := requireEditingDraft(ctx, tx, testID, sessionID)
	if err != nil {
		return Draft{}, err
	}
	if err := checkRevision(revision, d.Revision); err != nil {
		return Draft{}, err
	}
	var kind string
	if err = tx.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, testID).Scan(&kind); err != nil {
		return Draft{}, err
	}
	if kind == "usecase" {
		return Draft{}, fmt.Errorf("%w: Use Case editing requires Compose", ErrConflict)
	}
	d, err = saveDraftScript(ctx, tx, d, script, "manual")
	if err != nil {
		return Draft{}, err
	}
	if err := tx.Commit(); err != nil {
		return Draft{}, err
	}
	return d.Draft, nil
}

// Caller holds the Test/Draft locks and has checked the expected revision.
func saveDraftScript(ctx context.Context, tx *sql.Tx, d draftState, script, origin string) (draftState, error) {
	if script == d.Script {
		return d, nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,module,stages)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, d.TestID, d.Revision+1, script, scriptHash(script), d.timeoutMS, settingsJSON(d.WorkspaceSettings), jsonText(d.WorkspaceContext), origin, jsonText(d.Module), stagesJSON(d.Stages)); err != nil {
		return draftState{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE drafts SET current_revision=current_revision+1,
            validation_run_id=NULL,summary_run_id=NULL,summary_description=NULL,summary_background=NULL,summary_name=NULL,updated_at=now() WHERE test_id=$1`, d.TestID); err != nil {
		return draftState{}, err
	}
	return scanDraft(tx.QueryRowContext(ctx, draftSelect, d.TestID))
}

func (p *Postgres) ValidateDraft(ctx context.Context, testID, sessionID string, revision int) (Run, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	d, _, err := requireEditingDraft(ctx, tx, testID, sessionID)
	if err != nil {
		return Run{}, err
	}
	if err := checkRevision(revision, d.Revision); err != nil {
		return Run{}, err
	}
	if strings.TrimSpace(d.Script) == "" {
		return Run{}, fmt.Errorf("%w: save a non-empty script before validation", ErrInvalid)
	}
	if _, _, err := executionForDraft(ctx, tx, d); err != nil {
		return Run{}, err
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
	var kind string
	if err := tx.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, d.TestID).Scan(&kind); err != nil {
		return Run{}, err
	}
	if kind == "usecase" {
		return Run{}, fmt.Errorf("%w: Use Case validation requires Compose", ErrConflict)
	}
	bundle, err := bundleForDraft(ctx, tx, d)
	if err != nil {
		return Run{}, err
	}
	return enqueueValidationSnapshot(ctx, tx, d, bundle)
}

// Future Compose calls this only after its own Plan/candidate CAS gate.
func enqueueValidationSnapshot(ctx context.Context, tx *sql.Tx, d draftState, bundle *RunBundle) (Run, error) {
	script, hash, origin := d.Script, d.hash, d.ScriptOrigin
	var files, metadata any
	var bundleHash *string
	execution := d
	if bundle != nil {
		digest, err := bundle.hash()
		if err != nil {
			return Run{}, err
		}
		script, hash, origin = bundle.entry(), scriptHash(bundle.entry()), bundle.origin()
		files, metadata, bundleHash = jsonText(bundle.Files), bundle.metadata(), &digest
		execution.ScriptOrigin = origin
	}
	if bundle != nil && bundle.Module != nil {
		if _, err := reserveModuleVersion(ctx, tx, d, *bundleHash); err != nil {
			return Run{}, err
		}
	}
	auth, proposal, err := executionForDraft(ctx, tx, execution)
	if err != nil {
		return Run{}, err
	}
	id := NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO runs(id,test_id,kind,draft_revision,script_snapshot,script_hash,timeout_ms,workspace_settings,editing_session_id,workspace_id,workspace_context,script_origin,authorization_revision,scope_proposal_id,files_snapshot,bundle_hash,bundle_metadata)
 SELECT $1,$2,'validation',$3,$4,$5,$6,$7,$8,workspace_id,$9,$10,$11,$12,$13,$14,$15 FROM tests WHERE id=$2`, id, d.TestID, d.Revision, script, hash, d.timeoutMS, settingsJSON(d.WorkspaceSettings), d.EditingSessionID, jsonText(d.WorkspaceContext), origin, auth, proposal, files, bundleHash, metadata); err != nil {
		return Run{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE drafts SET validation_run_id=$2,summary_run_id=NULL,summary_description=NULL,summary_background=NULL,summary_name=NULL,updated_at=now() WHERE test_id=$1`, d.TestID, id); err != nil {
		return Run{}, err
	}
	return scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, id))
}

const versionColumns = `id,test_id,source_revision,script,created_at,validation_run_id,workspace_settings,description,background_summary,summary_run_id,editing_session_id,workspace_context,script_origin,COALESCE(module,'null'::jsonb),stages`

func scanVersion(row scanner) (Version, error) {
	var v Version
	var settings, context, module, stages []byte
	err := row.Scan(&v.ID, &v.TestID, &v.Revision, &v.Script, &v.CreatedAt, &v.ValidationRunID, &settings, &v.Description, &v.BackgroundSummary, &v.SummaryRunID, &v.EditingSessionID, &context, &v.ScriptOrigin, &module, &stages)
	if err == nil {
		v.WorkspaceSettings, err = decodeSettings(settings)
		if err == nil {
			v.WorkspaceContext, err = decodeWorkspaceContext(context)
		}
	}
	if err == nil {
		err = json.Unmarshal(module, &v.Module)
	}
	if err == nil {
		err = json.Unmarshal(stages, &v.Stages)
	}
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

func (p *Postgres) Publish(ctx context.Context, testID, sessionID string, revision int, summaryID string, confirmed bool) (Version, error) {
	if !confirmed || !ValidID(sessionID) || !ValidID(summaryID) {
		return Version{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Version{}, err
	}
	defer tx.Rollback()
	if _, err = lockEditingTest(ctx, tx, testID); err != nil {
		return Version{}, err
	}
	session, err := readEditing(ctx, tx, testID, sessionID)
	if err != nil {
		return Version{}, err
	}
	if session.Status == "published" {
		return scanVersion(tx.QueryRowContext(ctx, `SELECT `+versionColumns+` FROM test_versions WHERE editing_session_id=$1 AND source_revision=$2 AND summary_run_id=$3`, sessionID, revision, summaryID))
	}
	if session.Status != "active" {
		return Version{}, ErrConflict
	}
	d, err := scanDraft(tx.QueryRowContext(ctx, draftSelect+` FOR UPDATE OF d`, testID))
	if err != nil {
		return Version{}, err
	}
	if d.EditingSessionID != sessionID {
		return Version{}, ErrConflict
	}
	if _, _, err := executionForDraft(ctx, tx, d); err != nil {
		return Version{}, err
	}
	kind, err := summaryTargetKind(ctx, tx, testID)
	if err != nil {
		return Version{}, err
	}
	proof, err := p.validationProof(ctx, tx, d)
	if err != nil {
		return Version{}, err
	}
	if err = checkPublication(revision, confirmed, d, proof); err != nil {
		return Version{}, err
	}
	output, err := acceptedSummary(ctx, tx, session, d, summaryID, proof)
	if err != nil {
		return Version{}, err
	}
	if kind == "module" {
		if !runReclaimed(ctx, tx, proof.id) || !runReclaimed(ctx, tx, summaryID) {
			return Version{}, ErrConflict
		}
		_, hash, err := p.batchEvidence(ctx, tx, d)
		if err != nil {
			return Version{}, err
		}
		var id string
		if err = tx.QueryRowContext(ctx, `SELECT id FROM module_version_candidates WHERE test_id=$1 AND editing_session_id=$2 AND revision=$3 AND bundle_hash=$4`, testID, sessionID, d.Revision, hash).Scan(&id); err != nil {
			return Version{}, ErrConflict
		}
		name := output.Name
		if name == nil {
			var value string
			if err = tx.QueryRowContext(ctx, `SELECT name FROM tests WHERE id=$1`, testID).Scan(&value); err != nil {
				return Version{}, err
			}
			name = &value
		}
		published, err := publishBatchVersion(ctx, tx, id, d, session, summaryID, "", hash, output.Description, output.BackgroundSummary, *name)
		if err != nil {
			return Version{}, err
		}
		return published, tx.Commit()
	}
	published, err := scanVersion(tx.QueryRowContext(ctx, `INSERT INTO test_versions
 (id,test_id,version,source_revision,script,script_hash,timeout_ms,validation_run_id,workspace_settings,description,background_summary,summary_run_id,editing_session_id,workspace_context,script_origin)
 SELECT $1,$2,COALESCE(MAX(version),0)+1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 FROM test_versions WHERE test_id=$2 RETURNING `+versionColumns,
		NewID(), testID, d.Revision, d.Script, d.hash, d.timeoutMS, proof.id, settingsJSON(d.WorkspaceSettings), output.Description, output.BackgroundSummary, summaryID, sessionID, jsonText(d.WorkspaceContext), d.ScriptOrigin))
	if err != nil {
		return Version{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE tests SET published_version_id=$2,description=$3,name=COALESCE($4,name) WHERE id=$1`, testID, published.ID, output.Description, output.Name); err != nil {
		return Version{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET status='published',published_version_id=$2,closed_at=now() WHERE id=$1`, sessionID, published.ID); err != nil {
		return Version{}, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM drafts WHERE test_id=$1 AND editing_session_id=$2`, testID, sessionID); err != nil {
		return Version{}, err
	}
	if err = tx.Commit(); err != nil {
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
