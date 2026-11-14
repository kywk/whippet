package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

type ValidationStats struct {
	Expected   int     `json:"expected"`
	Unexpected int     `json:"unexpected"`
	Flaky      int     `json:"flaky"`
	Skipped    int     `json:"skipped"`
	Duration   float64 `json:"duration"`
}
type ValidationEvidence struct {
	RunID         string          `json:"runId"`
	AttemptID     string          `json:"attemptId"`
	DraftRevision int             `json:"draftRevision"`
	ScriptHash    string          `json:"scriptHash"`
	TimeoutMS     int             `json:"timeoutMs"`
	Status        string          `json:"status"`
	ReportsReady  bool            `json:"reportsReady"`
	Stats         ValidationStats `json:"stats"`
}

type summaryOutput struct {
	Message           string  `json:"message"`
	Description       string  `json:"description"`
	BackgroundSummary string  `json:"backgroundSummary"`
	Name              *string `json:"name,omitempty"`
}

func validOutputText(s string, limit int) bool {
	return strings.TrimSpace(s) != "" && len(s) <= limit && utf8.ValidString(s) && !strings.ContainsRune(s, '\x00')
}
func decodeSummaryOutput(data []byte) (summaryOutput, error) {
	var out summaryOutput
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if len(data) > int(MaxAuthorArtifactBytes) || dec.Decode(&out) != nil || dec.Decode(new(any)) != io.EOF || validateUserMessage(out.Message) != nil ||
		!validOutputText(out.Description, 16384) || !validOutputText(out.BackgroundSummary, 8192) || (out.Name != nil && !validOutputText(*out.Name, 200)) {
		return out, fmt.Errorf("invalid acceptance summary")
	}
	if out.Name != nil {
		trimmed := strings.TrimSpace(*out.Name)
		out.Name = &trimmed
	}
	return out, nil
}

func editingAuthorInput(s EditingSession, d draftState, skill string, messages []ChatMessage) AuthorInput {
	tools := []string{}
	if skill == "test-author" {
		tools = []string{"read_draft", "read_validation_report", "update_draft"}
	}
	return AuthorInput{SkillID: skill, SkillVersion: "1", AllowedTools: tools, EditingSessionID: s.ID, ContextRevision: s.ContextRevision,
		SourceVersion: s.SourceVersion, ConversationSummary: s.ConversationSummary, ConversationID: s.ConversationID, BaseRevision: d.Revision, Messages: messages}
}

func enqueueAuthor(ctx context.Context, tx *sql.Tx, d draftState, input AuthorInput, bindings ...Run) (Run, error) {
	if err := snapshotAuthor(&input); err != nil {
		return Run{}, err
	}
	return enqueueAuthorSnapshot(ctx, tx, d, input, bindings...)
}

func enqueueAuthorSnapshot(ctx context.Context, tx *sql.Tx, d draftState, input AuthorInput, bindings ...Run) (Run, error) {
	payload, err := json.Marshal(input)
	if err != nil {
		return Run{}, err
	}
	id := NewID()
	var binding Run
	if len(bindings) > 0 {
		binding = bindings[0]
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO runs(id,test_id,kind,draft_revision,script_snapshot,script_hash,timeout_ms,author_payload,workspace_settings,editing_session_id,workspace_id,workspace_context,script_origin,authorization_revision,scope_proposal_id,author_engine)
 SELECT $1,$2,'author',$3,$4,$5,$6,$7,$8,$9,t.workspace_id,$10,$11,$12,$13,
 CASE WHEN $14='test-author' THEN w.author_engine ELSE 'builtin' END FROM tests t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=$2`, id, d.TestID, d.Revision, d.Script, d.hash, input.Budget.MaxDurationMS, string(payload), settingsJSON(d.WorkspaceSettings), d.EditingSessionID, jsonText(d.WorkspaceContext), d.ScriptOrigin, binding.authorizationRevision, binding.scopeProposalID, input.SkillID); err != nil {
		return Run{}, err
	}
	return scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, id))
}

func clearDraftSummary(ctx context.Context, tx *sql.Tx, testID string) error {
	_, err := tx.ExecContext(ctx, `UPDATE drafts SET summary_run_id=NULL,summary_description=NULL,summary_background=NULL,summary_name=NULL WHERE test_id=$1`, testID)
	return err
}

func (p *Postgres) validationProof(ctx context.Context, tx *sql.Tx, d draftState) (validationEvidence, error) {
	return p.readValidationProof(ctx, tx, d, true)
}

func (p *Postgres) readValidationProof(ctx context.Context, tx *sql.Tx, d draftState, lock bool) (validationEvidence, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE OF r"
	}
	var v validationEvidence
	if d.ValidationRunID == nil {
		return v, fmt.Errorf("%w: current revision needs validation", ErrConflict)
	}
	var key sql.NullString
	var size sql.NullInt64
	var settings, context, files, metadata []byte
	var bundleHash *string
	err := tx.QueryRowContext(ctx, `SELECT r.id,r.test_id,r.kind,r.draft_revision,r.script_snapshot,COALESCE(r.script_hash,''),r.timeout_ms,r.status,
 a.storage_key,a.size_bytes,r.workspace_settings,r.editing_session_id,COALESCE(r.attempt_id::text,''),r.workspace_context,r.script_origin,r.files_snapshot,r.bundle_hash,r.bundle_metadata FROM runs r
 LEFT JOIN artifacts a ON a.run_id=r.id AND a.attempt_id=r.attempt_id AND a.name='report.html' WHERE r.id=$1`+suffix, *d.ValidationRunID).
		Scan(&v.id, &v.testID, &v.kind, &v.revision, &v.script, &v.hash, &v.timeoutMS, &v.status, &key, &size, &settings, &v.sessionID, &v.attemptID, &context, &v.scriptOrigin, &files, &bundleHash, &metadata)
	if err != nil {
		return v, err
	}
	v.bundle, err = decodeRunBundle(files, metadata, bundleHash, v.script, v.scriptOrigin)
	if err != nil {
		return v, err
	}
	v.expectedBundle, err = bundleForDraft(ctx, tx, d)
	if err != nil {
		return v, err
	}
	v.settings, err = decodeSettings(settings)
	if err == nil {
		v.workspaceContext, err = decodeWorkspaceContext(context)
	}
	v.reportReady = p.reportReady(key, size)
	if err == nil {
		err = loadRunRoles(ctx, tx, v.id)
	}
	return v, err
}

func (p *Postgres) readArtifactBytes(ctx context.Context, tx *sql.Tx, runID, attemptID, name string, limit int64) ([]byte, error) {
	var key, hash string
	var size int64
	if err := tx.QueryRowContext(ctx, `SELECT storage_key,size_bytes,sha256 FROM artifacts WHERE run_id=$1 AND attempt_id=$2 AND name=$3`, runID, attemptID, name).Scan(&key, &size, &hash); err != nil {
		return nil, err
	}
	if p.Artifacts == nil || size <= 0 || size > limit {
		return nil, fmt.Errorf("artifact unavailable")
	}
	f, err := p.Artifacts.Open(key)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) != size || scriptHash(string(data)) != hash {
		return nil, fmt.Errorf("artifact integrity mismatch")
	}
	return data, nil
}

func summaryBindingMatches(s EditingSession, d draftState, input AuthorInput, script string, settings *WorkspaceSettings, contexts ...*WorkspaceContext) bool {
	e := input.ValidationEvidence
	var snapshot *WorkspaceContext
	if len(contexts) > 0 {
		snapshot = contexts[0]
	}
	if !sameWorkspaceContext(d.WorkspaceContext, snapshot) || !moduleSummaryMatches(d, input) {
		return false
	}
	expectedHash := d.hash
	if input.ModuleSummary != nil {
		expectedHash = input.ModuleSummary.HarnessHash
	}
	return s.Status == "active" && s.ID == d.EditingSessionID && input.SkillID == "acceptance-summary" && input.SkillVersion == "1" && len(input.AllowedTools) == 0 &&
		input.EditingSessionID == s.ID && input.ConversationID == s.ConversationID && input.ContextRevision == s.ContextRevision && input.BaseRevision == d.Revision &&
		script == d.Script && sameWorkspaceSettings(settings, d.WorkspaceSettings) && e != nil && d.ValidationRunID != nil && e.RunID == *d.ValidationRunID &&
		ValidID(e.AttemptID) && e.DraftRevision == d.Revision && e.ScriptHash == expectedHash && e.TimeoutMS == d.timeoutMS && e.Status == "succeeded" && e.ReportsReady
}

func readSummaryRun(ctx context.Context, q queryDB, id string, lock bool) (Run, AuthorInput, string, *WorkspaceSettings, error) {
	var run Run
	var input AuthorInput
	var script string
	var raw, settings, context []byte
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	err := q.QueryRowContext(ctx, `SELECT id,status,test_id,script_snapshot,workspace_settings,author_payload,workspace_context,script_origin FROM runs WHERE id=$1 AND kind='author'`+suffix, id).
		Scan(&run.ID, &run.Status, &run.TestID, &script, &settings, &raw, &context, &run.ScriptOrigin)
	if err != nil {
		return run, input, script, nil, dbError(err)
	}
	if json.Unmarshal(raw, &input) != nil {
		return run, input, script, nil, ErrConflict
	}
	ws, err := decodeSettings(settings)
	if err == nil {
		run.WorkspaceContext, err = decodeWorkspaceContext(context)
	}
	return run, input, script, ws, err
}

func readEditingSummary(ctx context.Context, q queryDB, s EditingSession, d draftState) (*EditingSummary, error) {
	if d.summaryRunID == nil {
		return nil, nil
	}
	run, input, script, settings, err := readSummaryRun(ctx, q, *d.summaryRunID, false)
	if err != nil {
		return nil, err
	}
	info := &EditingSummary{RunID: run.ID, Status: run.Status, Revision: input.BaseRevision, Description: d.summaryDescription, BackgroundSummary: d.summaryBackground, Name: d.summaryName}
	if input.ValidationEvidence != nil {
		info.ValidationRunID = input.ValidationEvidence.RunID
	}
	info.ValidForCurrentDraft = effectiveScriptOrigin(run.ScriptOrigin) == effectiveScriptOrigin(d.ScriptOrigin) && stringValue(run.TestID) == s.TestID && run.Status == "succeeded" && d.summaryDescription != nil && d.summaryBackground != nil && summaryBindingMatches(s, d, input, script, settings, run.WorkspaceContext)
	return info, nil
}

func acceptedSummary(ctx context.Context, tx *sql.Tx, s EditingSession, d draftState, id string, proof validationEvidence) (summaryOutput, error) {
	var out summaryOutput
	if d.summaryRunID == nil || *d.summaryRunID != id || d.summaryDescription == nil || d.summaryBackground == nil {
		return out, fmt.Errorf("%w: current revision needs an acceptance summary", ErrConflict)
	}
	run, input, script, settings, err := readSummaryRun(ctx, tx, id, true)
	if err != nil {
		return out, err
	}
	if effectiveScriptOrigin(run.ScriptOrigin) != effectiveScriptOrigin(d.ScriptOrigin) || stringValue(run.TestID) != s.TestID || run.Status != "succeeded" || !summaryBindingMatches(s, d, input, script, settings, run.WorkspaceContext) || input.ValidationEvidence.AttemptID != proof.attemptID {
		return out, fmt.Errorf("%w: acceptance summary is stale", ErrConflict)
	}
	return summaryOutput{Description: *d.summaryDescription, BackgroundSummary: *d.summaryBackground, Name: d.summaryName}, nil
}

func (p *Postgres) CreateSummary(ctx context.Context, testID, sessionID string, revision int, validationID string) (Run, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	d, s, err := requireEditingDraft(ctx, tx, testID, sessionID)
	if err != nil {
		return Run{}, err
	}
	kind, err := summaryTargetKind(ctx, tx, testID)
	if err != nil {
		return Run{}, err
	}
	if err = checkRevision(revision, d.Revision); err != nil {
		return Run{}, err
	}
	if d.ValidationRunID == nil || *d.ValidationRunID != validationID {
		return Run{}, ErrConflict
	}
	proof, err := p.validationProof(ctx, tx, d)
	if err != nil {
		return Run{}, err
	}
	if err = checkPublication(revision, true, d, proof); err != nil {
		return Run{}, err
	}
	if kind == "module" && !runReclaimed(ctx, tx, proof.id) {
		return Run{}, ErrConflict
	}
	if d.summaryRunID != nil {
		r, input, script, settings, err := readSummaryRun(ctx, tx, *d.summaryRunID, true)
		if err != nil {
			return Run{}, err
		}
		if effectiveScriptOrigin(r.ScriptOrigin) == effectiveScriptOrigin(d.ScriptOrigin) && summaryBindingMatches(s, d, input, script, settings, r.WorkspaceContext) && (r.Status == "succeeded" || !Terminal(r.Status)) {
			return scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, r.ID))
		}
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE test_id=$1 AND kind='author' AND status IN ('queued','dispatched','running','collecting','cancelling'))`, testID).Scan(&active); err != nil {
		return Run{}, err
	}
	if active {
		return Run{}, ErrConflict
	}
	data, err := p.readArtifactBytes(ctx, tx, proof.id, proof.attemptID, "results.json", MaxArtifactBytes)
	if err != nil {
		return Run{}, fmt.Errorf("%w: validation JSON evidence unavailable", ErrConflict)
	}
	var report struct {
		Stats  *ValidationStats  `json:"stats"`
		Errors []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(data, &report) != nil || report.Stats == nil || report.Stats.Expected < 1 || report.Stats.Unexpected != 0 || report.Stats.Flaky < 0 || report.Stats.Skipped < 0 || report.Stats.Duration < 0 || report.Errors == nil || len(report.Errors) != 0 {
		return Run{}, fmt.Errorf("%w: invalid successful validation statistics", ErrConflict)
	}
	rows, err := tx.QueryContext(ctx, `SELECT role,content FROM messages WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT 12`, s.ConversationID)
	if err != nil {
		return Run{}, err
	}
	newest := []ChatMessage{}
	for rows.Next() {
		var m ChatMessage
		if err = rows.Scan(&m.Role, &m.Content); err != nil {
			rows.Close()
			return Run{}, err
		}
		newest = append(newest, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Run{}, err
	}
	input := editingAuthorInput(s, d, "acceptance-summary", authorContext(newest))
	input.ValidationEvidence = &ValidationEvidence{RunID: proof.id, AttemptID: proof.attemptID, DraftRevision: d.Revision, ScriptHash: d.hash, TimeoutMS: d.timeoutMS, Status: "succeeded", ReportsReady: true, Stats: *report.Stats}
	if kind == "module" {
		input.ModuleSummary, err = moduleSummarySnapshot(d)
		if err != nil {
			return Run{}, err
		}
		evidence, bundleHash, err := p.batchEvidence(ctx, tx, d)
		if err != nil || bundleHash != input.ModuleSummary.BundleHash {
			return Run{}, ErrConflict
		}
		input.ValidationEvidence = &evidence
	}
	run, err := enqueueAuthor(ctx, tx, d, input)
	if err != nil {
		return Run{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE drafts SET summary_run_id=$2,summary_description=NULL,summary_background=NULL,summary_name=NULL WHERE test_id=$1`, testID, run.ID); err != nil {
		return Run{}, err
	}
	if err = tx.Commit(); err != nil {
		return Run{}, err
	}
	return run, nil
}
