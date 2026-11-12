package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

const historyPageBytes = 8192
const historyPageItems = 6

var ErrHistoryUnavailable = errors.New("history_unavailable")

// This nonsecret bound is part of the existing immutable author payload.
type AuthorHistory struct {
	MaxSequence string `json:"maxSequence"`
}

type HistoryItem struct {
	Sequence       string `json:"sequence"`
	Role           string `json:"role"`
	Content        string `json:"content"`
	OffsetBytes    int64  `json:"offsetBytes"`
	HasMoreContent bool   `json:"hasMoreContent"`
}

type HistoryPage struct {
	WorkspaceID      string        `json:"workspaceId"`
	TestID           *string       `json:"testId"`
	RunID            string        `json:"runId"`
	AttemptID        string        `json:"attemptId"`
	EditingSessionID *string       `json:"editingSessionId"`
	ConversationID   string        `json:"conversationId"`
	MaxSequence      string        `json:"maxSequence"`
	Items            []HistoryItem `json:"items"`
	NextCursor       *string       `json:"nextCursor"`
}

func conversationHistorySnapshot(ctx context.Context, q queryDB, conversation string) (*AuthorHistory, error) {
	h := &AuthorHistory{}
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0)::text FROM messages WHERE conversation_id=$1`, conversation).Scan(&h.MaxSequence)
	return h, err
}

func historySequence(value string) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != value {
		return 0, ErrInvalid
	}
	return n, nil
}

func historyCursor(cursor *string, max int64) (sequence, offset int64, err error) {
	if cursor == nil {
		return max, 0, nil
	}
	parts := strings.Split(*cursor, ":")
	if len(parts) != 2 || len(*cursor) > 40 {
		return 0, 0, ErrInvalid
	}
	sequence, err = historySequence(parts[0])
	if err != nil || sequence > max {
		return 0, 0, ErrInvalid
	}
	offset, err = historySequence(parts[1])
	if err != nil || offset > 9007199254740991 {
		return 0, 0, ErrInvalid
	}
	return sequence, offset, nil
}

func historyPosition(sequence, offset int64) *string {
	return stringPointer(strconv.FormatInt(sequence, 10) + ":" + strconv.FormatInt(offset, 10))
}

type historyRow struct {
	sequence int64
	role     string
	content  []byte // At most historyPageBytes+4, starting at this row's offset.
	total    int64
}

// Rows are newest first. One look-ahead row distinguishes a full last page from
// a continuation. Offsets refer to UTF-8 bytes, never JS string code units.
func historyFragments(rows []historyRow, sequence, offset int64) ([]HistoryItem, *string, error) {
	items := []HistoryItem{}
	if offset > 0 && (len(rows) == 0 || rows[0].sequence != sequence) {
		return nil, nil, ErrInvalid
	}
	remaining := historyPageBytes
	for _, row := range rows {
		start := int64(0)
		if row.sequence == sequence {
			start = offset
		}
		if start > row.total || len(row.content) > 0 && !utf8.RuneStart(row.content[0]) {
			return nil, nil, ErrInvalid
		}
		if start > 0 && start == row.total {
			continue
		}
		if len(items) == historyPageItems || remaining == 0 {
			return items, historyPosition(row.sequence, start), nil
		}
		n := min(len(row.content), remaining)
		for n > 0 && !utf8.Valid(row.content[:n]) {
			n--
		}
		if n == 0 && row.total > start {
			return items, historyPosition(row.sequence, start), nil
		}
		more := start+int64(n) < row.total
		items = append(items, HistoryItem{Sequence: strconv.FormatInt(row.sequence, 10), Role: row.role,
			Content: string(row.content[:n]), OffsetBytes: start, HasMoreContent: more})
		remaining -= n
		if more {
			return items, historyPosition(row.sequence, start+int64(n)), nil
		}
	}
	return items, nil, nil
}

func (a *API) conversationHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.TLS == nil {
		writeError(w, 400, "protected_transport_required", "Manager history requires TLS")
		return
	}
	id, attempt := r.PathValue("id"), r.PathValue("attemptId")
	if !ValidID(id) || !ValidID(attempt) {
		a.fail(w, ErrInvalid)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var body struct {
		Cursor json.RawMessage `json:"cursor"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	var cursor *string
	if len(body.Cursor) == 0 || json.Unmarshal(body.Cursor, &cursor) != nil {
		a.fail(w, ErrInvalid)
		return
	}
	if _, _, err := historyCursor(cursor, 9223372036854775807); err != nil {
		a.fail(w, err)
		return
	}
	manager, epoch, ready := a.engine.credentialManager()
	if !ready {
		a.fail(w, ErrHistoryUnavailable)
		return
	}
	page, err := a.store.ConversationHistory(r.Context(), manager, id, attempt, cursor)
	if err != nil {
		a.fail(w, err)
		return
	}
	current, currentEpoch, ready := a.engine.credentialManager()
	if !ready || current != manager || currentEpoch != epoch {
		a.fail(w, ErrHistoryUnavailable)
		return
	}
	writeJSON(w, 200, page)
}

func (p *Postgres) ConversationHistory(ctx context.Context, manager, run, attempt string, cursor *string) (HistoryPage, error) {
	page := HistoryPage{RunID: run, AttemptID: attempt, Items: []HistoryItem{}}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	var kind string
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT workspace_id,test_id,editing_session_id,kind,author_payload FROM runs WHERE id=$1`, run).
		Scan(&page.WorkspaceID, &page.TestID, &page.EditingSessionID, &kind, &raw)
	if err != nil {
		return page, dbError(err)
	}
	var input AuthorInput
	if kind != "author" || json.Unmarshal(raw, &input) != nil || input.SkillVersion != "1" || input.History == nil ||
		!ValidID(input.ConversationID) || !containsHistoryTool(input.AllowedTools) {
		return page, ErrHistoryUnavailable
	}
	max, err := historySequence(input.History.MaxSequence)
	if err != nil {
		return page, ErrHistoryUnavailable
	}
	sequence, offset, err := historyCursor(cursor, max)
	if err != nil {
		return page, err
	}
	page.ConversationID, page.MaxSequence = input.ConversationID, input.History.MaxSequence
	// Preserve the existing Workspace -> Test/Conversation -> Draft -> Run lock
	// order. Cancellation cannot change the checked Run while this page is read.
	switch input.SkillID {
	case "test-author":
		if page.TestID == nil || page.EditingSessionID == nil || input.EditingSessionID != *page.EditingSessionID {
			return page, ErrHistoryUnavailable
		}
		d, s, err := requireEditingDraft(ctx, tx, *page.TestID, *page.EditingSessionID)
		if err != nil {
			if errors.Is(err, ErrNotFound) || errors.Is(err, ErrConflict) {
				return page, ErrHistoryUnavailable
			}
			return page, err
		}
		if s.WorkspaceID != page.WorkspaceID || s.ConversationID != input.ConversationID || d.Revision != input.BaseRevision || s.ContextRevision != input.ContextRevision {
			return page, ErrHistoryUnavailable
		}
	case "workspace-author":
		if page.TestID != nil || page.EditingSessionID != nil || input.EditingSessionID != "" {
			return page, ErrHistoryUnavailable
		}
		w, _, err := readWorkspaceCore(ctx, tx, page.WorkspaceID, true)
		if err != nil {
			return page, err
		}
		var conversation string
		var revision int64
		if err = tx.QueryRowContext(ctx, `SELECT id,context_revision FROM conversations WHERE workspace_id=$1 AND owner_type='workspace'
 AND test_id IS NULL AND editing_session_id IS NULL FOR SHARE`, page.WorkspaceID).Scan(&conversation, &revision); err != nil {
			return page, dbError(err)
		}
		if conversation != input.ConversationID || w.Revision != input.BaseRevision || revision != input.ContextRevision {
			return page, ErrHistoryUnavailable
		}
	default:
		return page, ErrHistoryUnavailable
	}
	var owned bool
	owner := "test"
	if page.TestID == nil {
		owner = "workspace"
	}
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM conversations WHERE id=$1 AND workspace_id=$2
 AND test_id IS NOT DISTINCT FROM $3::uuid AND editing_session_id IS NOT DISTINCT FROM $4::uuid AND owner_type=$5)`,
		input.ConversationID, page.WorkspaceID, page.TestID, page.EditingSessionID, owner).Scan(&owned); err != nil {
		return page, err
	}
	if !owned {
		return page, ErrHistoryUnavailable
	}
	var assigned, currentAttempt *string
	var status string
	var released bool
	if err = tx.QueryRowContext(ctx, `SELECT manager_id,attempt_id,status,slot_released FROM runs WHERE id=$1 FOR SHARE`, run).
		Scan(&assigned, &currentAttempt, &status, &released); err != nil {
		return page, dbError(err)
	}
	if assigned == nil || *assigned != manager || currentAttempt == nil || *currentAttempt != attempt || released || (status != "dispatched" && status != "running") {
		return page, ErrHistoryUnavailable
	}
	// Bound database reads as well as response size. Clamp only the extraction
	// position; historyFragments still rejects an offset beyond the real length.
	rows, err := tx.QueryContext(ctx, `SELECT sequence,role,octet_length(content),substring(convert_to(content,'UTF8')
 FROM (CASE WHEN sequence=$2 THEN LEAST($3::bigint,octet_length(content)::bigint) ELSE 0 END)::integer+1 FOR $4)
 FROM messages WHERE conversation_id=$1 AND sequence<=$2 ORDER BY sequence DESC LIMIT $5`,
		input.ConversationID, sequence, offset, historyPageBytes+4, historyPageItems+2)
	if err != nil {
		return page, err
	}
	var values []historyRow
	for rows.Next() {
		var value historyRow
		if err = rows.Scan(&value.sequence, &value.role, &value.total, &value.content); err != nil {
			rows.Close()
			return page, err
		}
		values = append(values, value)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return page, err
	}
	page.Items, page.NextCursor, err = historyFragments(values, sequence, offset)
	if err != nil {
		return page, err
	}
	if err = tx.Commit(); err != nil {
		return page, err
	}
	return page, nil
}

func containsHistoryTool(tools []string) bool {
	for _, name := range tools {
		if name == "read_conversation_history" {
			return true
		}
	}
	return false
}
