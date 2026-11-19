package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

type TestReplacement struct {
	SourceTest Test `json:"sourceTest"`
	Test       Test `json:"test"`
}

func isNewTestRecommendation(flag bool, message string) bool {
	// Older Workers appended this fixed sentence after detecting the same intent.
	const legacyGuidance = "\n\n請使用「新增測試」，把這個流程建立成獨立的測試案例。"
	return flag || strings.HasSuffix(strings.TrimSpace(message), legacyGuidance)
}

func replacementPrompt(ctx context.Context, tx *sql.Tx, session EditingSession, replyID string, revision int) (string, error) {
	var prompt, reply string
	var flag bool
	err := tx.QueryRowContext(ctx, `SELECT requested.content,reply.content,reply.new_test_needed
 FROM messages reply JOIN messages requested ON requested.conversation_id=reply.conversation_id
  AND requested.run_id=reply.run_id AND requested.role='user'
 WHERE reply.id=$1 AND reply.conversation_id=$2 AND reply.role='assistant' AND reply.base_revision=$3
  AND reply.applied_revision IS NULL AND reply.proposed_script IS NULL AND reply.validation_run_id IS NULL
  AND reply.sequence=(SELECT MAX(sequence) FROM messages WHERE conversation_id=$2)`,
		replyID, session.ConversationID, revision).Scan(&prompt, &reply, &flag)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !isNewTestRecommendation(flag, reply)) {
		return "", fmt.Errorf("%w: the recommendation no longer matches the conversation", ErrConflict)
	}
	if err != nil {
		return "", err
	}
	return prompt, validateUserMessage(prompt)
}

func (p *Postgres) ReplaceDraftWithNewTest(ctx context.Context, testID, sessionID string, revision int, replyID string) (TestReplacement, error) {
	var result TestReplacement
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if _, err = lockEditingTest(ctx, tx, testID); err != nil {
		return result, err
	}
	source, err := readEditing(ctx, tx, testID, sessionID)
	if err != nil {
		return result, err
	}
	var replacementID *string
	if err = tx.QueryRowContext(ctx, `SELECT e.replacement_test_id FROM editing_sessions e JOIN tests t ON t.id=e.test_id
 WHERE e.id=$1 AND t.kind='test'`, source.ID).Scan(&replacementID); err != nil {
		return result, dbError(err)
	}
	prompt, err := replacementPrompt(ctx, tx, source, replyID, revision)
	if err != nil {
		return result, err
	}
	if replacementID == nil {
		if source.Status != "active" {
			return result, ErrConflict
		}
		if err := discardEditingInTx(ctx, tx, source, revision); err != nil {
			return result, err
		}
		newTest, err := insertTest(ctx, tx, source.WorkspaceID, "", "")
		if err != nil {
			return result, err
		}
		session, _, err := startEditingSessionInTx(ctx, tx, newTest.ID)
		if err != nil {
			return result, err
		}
		draft, err := scanDraft(tx.QueryRowContext(ctx, draftSelect, newTest.ID))
		if err != nil {
			return result, err
		}
		if _, err = p.createAuthorInTx(ctx, tx, draft, session, prompt); err != nil {
			return result, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET replacement_test_id=$2 WHERE id=$1`, source.ID, newTest.ID); err != nil {
			return result, err
		}
		replacementID = &newTest.ID
	}
	result.SourceTest, err = readTest(ctx, tx, testID)
	if err != nil {
		return result, err
	}
	result.Test, err = readTest(ctx, tx, *replacementID)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}
