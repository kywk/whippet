package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const authorTimeoutMS = 180000

func (p *Postgres) Conversation(ctx context.Context, testID, sessionID string) (Conversation, error) {
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return Conversation{}, err
	}
	defer tx.Rollback()
	session, err := readEditing(ctx, tx, testID, sessionID)
	if err != nil {
		return Conversation{}, err
	}
	id := session.ConversationID
	c := Conversation{ID: id, TestID: testID, EditingSessionID: session.ID, Messages: []Message{}}
	rows, err := tx.QueryContext(ctx, `SELECT m.id,m.role,m.content,m.created_at,m.run_id,m.base_revision,
        m.applied_revision,m.proposed_script,m.validation_run_id,
        CASE WHEN m.role='assistant' THEN dr.script ELSE NULL END
        FROM messages m LEFT JOIN draft_revisions dr ON dr.test_id=$2 AND dr.revision=m.base_revision
        WHERE m.conversation_id=$1 ORDER BY m.sequence`, id, testID)
	if err != nil {
		return Conversation{}, err
	}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Role, &m.Content, &m.CreatedAt, &m.RunID, &m.BaseRevision,
			&m.AppliedRevision, &m.ProposedScript, &m.ValidationRunID, &m.BaseScript); err != nil {
			rows.Close()
			return Conversation{}, err
		}
		m.CreatedAt = m.CreatedAt.UTC()
		c.Messages = append(c.Messages, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Conversation{}, err
	}
	err = tx.QueryRowContext(ctx, `SELECT id FROM runs WHERE editing_session_id=$1 AND kind='author'
        AND status IN ('queued','dispatched','running','collecting','cancelling')`, session.ID).Scan(&c.ActiveRunID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, err
	}
	if err := tx.Commit(); err != nil {
		return Conversation{}, err
	}
	return c, nil
}

func validateUserMessage(content string) error {
	if strings.TrimSpace(content) == "" || !utf8.ValidString(content) || strings.ContainsRune(content, '\x00') || utf8.RuneCountInString(content) > 16000 {
		return fmt.Errorf("%w: message must contain 1..16000 characters", ErrInvalid)
	}
	return nil
}

// Input is newest first. Preserve this turn's complete user message, then trim
// earlier context to 12 messages / 32000 Unicode characters, returning oldest first.
func authorContext(newest []ChatMessage) []ChatMessage {
	remaining := 32000
	context := make([]ChatMessage, 0, min(len(newest), 12))
	for _, message := range newest {
		if len(context) == 12 || remaining == 0 {
			break
		}
		text := []rune(message.Content)
		if len(text) > remaining {
			text = text[:remaining]
		}
		context = append(context, ChatMessage{Role: message.Role, Content: string(text)})
		remaining -= len(text)
	}
	for left, right := 0, len(context)-1; left < right; left, right = left+1, right-1 {
		context[left], context[right] = context[right], context[left]
	}
	return context
}

func validationSnapshot(runID, status, errorMessage string) *AuthorValidation {
	characters := []rune(errorMessage)
	if len(characters) > 4000 {
		errorMessage = string(characters[:4000])
	}
	return &AuthorValidation{RunID: runID, Status: status, Error: errorMessage}
}

func (p *Postgres) CreateAuthor(ctx context.Context, testID, sessionID, content string, revision int) (AuthorSubmission, error) {
	if err := validateUserMessage(content); err != nil {
		return AuthorSubmission{}, err
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return AuthorSubmission{}, err
	}
	defer tx.Rollback()
	d, session, err := requireEditingDraft(ctx, tx, testID, sessionID)
	if err != nil {
		return AuthorSubmission{}, err
	}
	if err := checkRevision(revision, d.Revision); err != nil {
		return AuthorSubmission{}, err
	}
	var active bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE test_id=$1 AND kind='author'
        AND status IN ('queued','dispatched','running','collecting','cancelling'))`, testID).Scan(&active); err != nil {
		return AuthorSubmission{}, err
	}
	if active {
		return AuthorSubmission{}, fmt.Errorf("%w: an author run is already active", ErrConflict)
	}
	conversationID := session.ConversationID
	newest := []ChatMessage{{Role: "user", Content: content}}
	rows, err := tx.QueryContext(ctx, `SELECT role,content FROM messages WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT 11`, conversationID)
	if err != nil {
		return AuthorSubmission{}, err
	}
	for rows.Next() {
		var message ChatMessage
		if err := rows.Scan(&message.Role, &message.Content); err != nil {
			rows.Close()
			return AuthorSubmission{}, err
		}
		newest = append(newest, message)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return AuthorSubmission{}, err
	}
	session.ContextRevision++
	input := editingAuthorInput(session, d, "test-author", authorContext(newest))
	if d.ValidationRunID != nil {
		var runID, status, errorMessage string
		if err := tx.QueryRowContext(ctx, `SELECT id,status,error FROM runs
            WHERE id=$1 AND test_id=$2 AND kind='validation'`, *d.ValidationRunID, testID).
			Scan(&runID, &status, &errorMessage); err != nil {
			return AuthorSubmission{}, dbError(err)
		}
		input.Validation = validationSnapshot(runID, status, errorMessage)
	}
	auth, proposal, err := p.prepareAuthor(ctx, tx, d, &input)
	if err != nil {
		return AuthorSubmission{}, err
	}
	run, err := enqueueAuthor(ctx, tx, d, input, Run{authorizationRevision: auth, scopeProposalID: proposal})
	if err != nil {
		return AuthorSubmission{}, err
	}
	runID := run.ID
	if _, err := tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id,base_revision)
        VALUES($1,$2,'user',$3,$4,$5)`, NewID(), conversationID, content, runID, revision); err != nil {
		return AuthorSubmission{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=$1`, sessionID); err != nil {
		return AuthorSubmission{}, err
	}
	if err := clearDraftSummary(ctx, tx, testID); err != nil {
		return AuthorSubmission{}, err
	}
	if err := tx.Commit(); err != nil {
		return AuthorSubmission{}, err
	}
	return AuthorSubmission{Run: run, ConversationID: conversationID}, nil
}
