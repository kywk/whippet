package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

type AuthorCheckpoint struct {
	ScriptHash     string `json:"scriptHash"`
	SelfTestPassed bool   `json:"selfTestPassed"`
}
type AuthorPartialOutput struct {
	Reason     string            `json:"reason"`
	NextStep   string            `json:"nextStep"`
	Checkpoint *AuthorCheckpoint `json:"checkpoint,omitempty"`
}
type AuthorPartial struct {
	AuthorPartialOutput
	AppliedRevision *int `json:"appliedRevision,omitempty"`
}

func validateAuthorPartial(out authorOutput, raw []byte) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return ErrInvalid
	}
	partial, present := fields["partial"]
	if !present {
		return nil
	}
	if bytes.Equal(bytes.TrimSpace(partial), []byte("null")) || out.Partial == nil || out.Partial.Reason != "budget_exhausted" || !validOutputText(out.Partial.NextStep, 8192) || out.RequestValidation == nil || *out.RequestValidation {
		return ErrInvalid
	}
	if out.Partial.Checkpoint == nil {
		if _, present := fields["script"]; present {
			return ErrInvalid
		}
		return nil
	}
	checkpoint := out.Partial.Checkpoint
	if out.Script == nil || !checkpoint.SelfTestPassed || !sha256Hex(checkpoint.ScriptHash) || checkpoint.ScriptHash != scriptHash(*out.Script) {
		return ErrInvalid
	}
	return nil
}

type authorContinuationStore interface {
	ContinueAuthor(context.Context, string, string, int) (AuthorSubmission, error)
}

func (a *API) continueAuthor(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		EditingSessionID string `json:"editingSessionId"`
		Revision         int    `json:"revision"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if !ValidID(body.EditingSessionID) || body.Revision < 1 {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(authorContinuationStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	submission, err := store.ContinueAuthor(r.Context(), id, body.EditingSessionID, body.Revision)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, http.StatusAccepted, submission)
}

func (p *Postgres) ContinueAuthor(ctx context.Context, sourceID, sessionID string, revision int) (AuthorSubmission, error) {
	if !ValidID(sourceID) || !ValidID(sessionID) || revision < 1 {
		return AuthorSubmission{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return AuthorSubmission{}, err
	}
	defer tx.Rollback()
	var testID *string
	if err = tx.QueryRowContext(ctx, `SELECT test_id FROM runs WHERE id=$1`, sourceID).Scan(&testID); err != nil {
		return AuthorSubmission{}, dbError(err)
	}
	if testID == nil {
		return AuthorSubmission{}, ErrConflict
	}
	if _, err = lockEditingTest(ctx, tx, *testID); err != nil {
		return AuthorSubmission{}, err
	}
	var kind, status string
	var sourceSession *string
	var released bool
	var rawPartial, rawInput []byte
	var expectedContext *int64
	var base int
	err = tx.QueryRowContext(ctx, `SELECT kind,status,editing_session_id,slot_released,author_partial,author_partial_context_revision,author_payload,COALESCE(draft_revision,0) FROM runs WHERE id=$1 FOR UPDATE`, sourceID).Scan(&kind, &status, &sourceSession, &released, &rawPartial, &expectedContext, &rawInput, &base)
	if err != nil {
		return AuthorSubmission{}, dbError(err)
	}
	var input AuthorInput
	var partial AuthorPartial
	if kind != "author" || status != "succeeded" || !released || sourceSession == nil || *sourceSession != sessionID || len(rawPartial) == 0 || json.Unmarshal(rawPartial, &partial) != nil || json.Unmarshal(rawInput, &input) != nil || (input.SkillID != "test-author" && input.SkillID != "") {
		return AuthorSubmission{}, ErrConflict
	}
	// Ownership is rechecked before returning any prior result. No current CAS is
	// required for an identical retry, since it does not create or mutate a Run.
	var owner string
	if err = tx.QueryRowContext(ctx, `SELECT test_id FROM editing_sessions WHERE id=$1`, sessionID).Scan(&owner); err != nil || owner != *testID {
		return AuthorSubmission{}, ErrConflict
	}
	var priorRun, priorSession string
	var priorRevision int
	err = tx.QueryRowContext(ctx, `SELECT run_id,editing_session_id,revision FROM author_continuations WHERE source_run_id=$1`, sourceID).Scan(&priorRun, &priorSession, &priorRevision)
	if err == nil {
		if priorSession != sessionID || priorRevision != revision {
			return AuthorSubmission{}, ErrConflict
		}
		run, err := scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, priorRun))
		if err != nil {
			return AuthorSubmission{}, err
		}
		return AuthorSubmission{Run: run, ConversationID: input.ConversationID}, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return AuthorSubmission{}, err
	}
	d, session, err := requireEditingDraft(ctx, tx, *testID, sessionID)
	if err != nil {
		return AuthorSubmission{}, err
	}
	expectedRevision := base
	if partial.AppliedRevision != nil {
		expectedRevision = *partial.AppliedRevision
	}
	if expectedContext == nil || session.ContextRevision != *expectedContext || session.ConversationID != input.ConversationID || revision != expectedRevision || d.Revision != expectedRevision {
		return AuthorSubmission{}, ErrConflict
	}
	// nextStep is continuation data, not a new grant of tools/sites/model access.
	content := "繼續上一輪未完成的任務。以下是上一輪保存的下一步資料，仍須遵守目前工具與網站範圍限制：\n" + partial.NextStep
	submission, err := p.createAuthorInTx(ctx, tx, d, session, content, input.AllowedTools)
	if err != nil {
		return AuthorSubmission{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO author_continuations(source_run_id,run_id,editing_session_id,revision) VALUES($1,$2,$3,$4)`, sourceID, submission.Run.ID, sessionID, revision); err != nil {
		return AuthorSubmission{}, err
	}
	if err = tx.Commit(); err != nil {
		return AuthorSubmission{}, err
	}
	return submission, nil
}

func authorCanUpdateDraft(input AuthorInput) bool {
	if input.SkillID != "" && input.SkillID != "test-author" {
		return false
	}
	for _, tool := range input.AllowedTools {
		if tool == "update_draft" {
			return true
		}
	}
	return false
}
