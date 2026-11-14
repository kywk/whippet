package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
)

type externalToolReceipt struct {
	Value     json.RawMessage `json:"value,omitempty"`
	Error     string          `json:"error,omitempty"`
	Retryable bool            `json:"-"`
}

func externalToolCallState(receipt externalToolReceipt) string {
	if receipt.Error == "unknown_result" {
		return "unknown"
	}
	if receipt.Error == "busy" && receipt.Retryable {
		return "pending"
	}
	return "replied"
}

func (p *Postgres) ReserveExternalToolCall(ctx context.Context, token AgentToken, runID, attemptID, leaseID, callID, name string, args []byte, registry *ToolRegistry) (externalClaim, externalToolReceipt, bool, error) {
	var empty externalToolReceipt
	if !ValidID(callID) {
		return externalClaim{}, empty, false, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return externalClaim{}, empty, false, err
	}
	defer tx.Rollback()
	c, err := p.lockExternalClaim(ctx, tx, token, runID, attemptID, leaseID)
	if err != nil {
		return c, empty, false, err
	}
	if err = p.externalLive(ctx, tx, c); err != nil {
		return c, empty, false, err
	}
	allowed := false
	for _, tool := range c.AllowedTools {
		if tool == name {
			allowed = true
			break
		}
	}
	if !allowed {
		return c, empty, false, ErrInvalid
	}
	tool, ok := registry.tool(name)
	if !ok {
		return c, empty, false, ErrInvalid
	}
	if _, err = validateToolArguments(tool, args); err != nil {
		return c, empty, false, err
	}
	digest := sha256.Sum256(append(append([]byte(name), 0), args...))
	var priorHash, raw []byte
	var state string
	err = tx.QueryRowContext(ctx, `SELECT request_hash,state,result FROM external_author_tool_calls WHERE run_id=$1 AND call_id=$2`, runID, callID).Scan(&priorHash, &state, &raw)
	if err == nil {
		if !equalBytes(priorHash, digest[:]) {
			return c, empty, false, ErrConflict
		}
		if state == "sent" {
			return c, externalToolReceipt{Error: "busy"}, true, tx.Commit()
		}
		if state == "pending" {
			if _, err = tx.ExecContext(ctx, `UPDATE external_author_tool_calls SET state='sent' WHERE run_id=$1 AND call_id=$2 AND state='pending'`, runID, callID); err != nil {
				return c, empty, false, err
			}
			return c, empty, false, tx.Commit()
		}
		if state == "unknown" {
			return c, externalToolReceipt{Error: "unknown_result"}, true, tx.Commit()
		}
		if json.Unmarshal(raw, &empty) != nil {
			return c, empty, false, ErrInvalid
		}
		return c, empty, true, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return c, empty, false, err
	}
	var rawInput []byte
	if err = tx.QueryRowContext(ctx, `SELECT author_payload FROM runs WHERE id=$1`, runID).Scan(&rawInput); err != nil {
		return c, empty, false, err
	}
	var input AuthorInput
	if json.Unmarshal(rawInput, &input) != nil || input.Budget == nil {
		return c, empty, false, ErrInvalid
	}
	var used int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM external_author_tool_calls WHERE run_id=$1`, runID).Scan(&used); err != nil {
		return c, empty, false, err
	}
	if used >= input.Budget.MaxToolCalls {
		return c, empty, false, ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO external_author_tool_calls(run_id,call_id,request_hash,state) VALUES($1,$2,$3,'sent')`, runID, callID, digest[:]); err != nil {
		return c, empty, false, err
	}
	return c, empty, false, tx.Commit()
}

func (p *Postgres) CompleteExternalToolCall(ctx context.Context, runID, callID string, receipt externalToolReceipt) error {
	state := externalToolCallState(receipt)
	_, err := p.DB.ExecContext(ctx, `UPDATE external_author_tool_calls SET state=$3,result=$4 WHERE run_id=$1 AND call_id=$2 AND state='sent'`, runID, callID, state, jsonText(receipt))
	return err
}

func (p *Postgres) BindExternalBrowser(ctx context.Context, token AgentToken, c externalClaim, sessionID string) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, err := p.lockExternalClaim(ctx, tx, token, c.RunID, c.AttemptID, c.LeaseID)
	if err != nil {
		return err
	}
	if err = p.externalLive(ctx, tx, current); err != nil {
		return err
	}
	if current.BrowserSessionID != nil && *current.BrowserSessionID != sessionID {
		return ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `UPDATE external_author_claims SET browser_session_id=$2 WHERE run_id=$1 AND browser_session_id IS NULL`, c.RunID, sessionID); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *Postgres) ExternalBrowser(ctx context.Context, token AgentToken, runID, attemptID, leaseID string) (*string, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	c, err := p.lockExternalClaim(ctx, tx, token, runID, attemptID, leaseID)
	if err != nil {
		return nil, err
	}
	if err = p.externalLive(ctx, tx, c); err != nil {
		return nil, err
	}
	return c.BrowserSessionID, tx.Commit()
}

func (p *Postgres) ExternalConversationHistory(ctx context.Context, c externalClaim, cursor *string) (HistoryPage, error) {
	page := HistoryPage{RunID: c.RunID, AttemptID: c.AttemptID, WorkspaceID: c.WorkspaceID, Items: []HistoryItem{}}
	var raw []byte
	var testID, sessionID *string
	err := p.DB.QueryRowContext(ctx, `SELECT author_payload,test_id,editing_session_id FROM runs WHERE id=$1 AND attempt_id=$2 AND workspace_id=$3`, c.RunID, c.AttemptID, c.WorkspaceID).Scan(&raw, &testID, &sessionID)
	if err != nil {
		return page, dbError(err)
	}
	var input AuthorInput
	if json.Unmarshal(raw, &input) != nil || input.History == nil || (input.SkillID != "test-author" && input.SkillID != "module-authoring" && input.SkillID != "usecase-planner" && input.SkillID != "workspace-author") {
		return page, ErrHistoryUnavailable
	}
	max, err := historySequence(input.History.MaxSequence)
	if err != nil {
		return page, err
	}
	seq, offset, err := historyCursor(cursor, max)
	if err != nil {
		return page, err
	}
	page.TestID = testID
	page.EditingSessionID = sessionID
	page.ConversationID = input.ConversationID
	page.MaxSequence = input.History.MaxSequence
	rows, err := p.DB.QueryContext(ctx, `SELECT sequence,role,octet_length(content),substring(convert_to(content,'UTF8')
 FROM (CASE WHEN sequence=$2 THEN LEAST($3::bigint,octet_length(content)::bigint) ELSE 0 END)::integer+1 FOR $4)
 FROM messages WHERE conversation_id=$1 AND sequence<=$2 ORDER BY sequence DESC LIMIT $5`, input.ConversationID, seq, offset, historyPageBytes+4, historyPageItems+2)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	values := []historyRow{}
	for rows.Next() {
		var v historyRow
		if err = rows.Scan(&v.sequence, &v.role, &v.total, &v.content); err != nil {
			return page, err
		}
		values = append(values, v)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	page.Items, page.NextCursor, err = historyFragments(values, seq, offset)
	return page, err
}

func (p *Postgres) ExpireExternalClaims(ctx context.Context) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT run_id,browser_session_id FROM external_author_claims WHERE state='active' AND (expires_at<=now() OR deadline_at<=now()) FOR UPDATE`)
	if err != nil {
		return err
	}
	type expired struct {
		run     string
		browser *string
	}
	list := []expired{}
	for rows.Next() {
		var v expired
		if err = rows.Scan(&v.run, &v.browser); err != nil {
			rows.Close()
			return err
		}
		list = append(list, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range list {
		if _, err = tx.ExecContext(ctx, `UPDATE external_author_claims SET state='timed_out' WHERE run_id=$1 AND state='active'`, v.run); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE runs SET status='timed_out',error=$2,finished_at=now() WHERE id=$1 AND status='running'`, v.run, "AI authoring timed out. The saved draft is unchanged; you can retry."); err != nil {
			return err
		}
		if v.browser != nil {
			if _, err = tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing' WHERE session_id=$1 AND NOT reclaimed`, *v.browser); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (p *Postgres) RecoverExternalClaims(ctx context.Context) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET status='interrupted',error='external author lease interrupted',finished_at=now() WHERE id IN (SELECT run_id FROM external_author_claims WHERE state='active') AND status='running'`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing' WHERE session_id IN (SELECT browser_session_id FROM external_author_claims WHERE state='active') AND NOT reclaimed`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE external_author_claims SET state='cancelled' WHERE state='active'`); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *Postgres) CancelExternalClaim(ctx context.Context, runID string) error {
	_, err := p.DB.ExecContext(ctx, `UPDATE external_author_claims SET state='cancelled' WHERE run_id=$1 AND state='active'`, runID)
	if err != nil {
		return err
	}
	_, err = p.DB.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing' WHERE session_id IN (SELECT browser_session_id FROM external_author_claims WHERE run_id=$1) AND NOT reclaimed`, runID)
	return err
}

func (p *Postgres) RevokeExternalClaims(ctx context.Context, tx *sql.Tx, tokenID string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET status='cancelled',error='external author token revoked',finished_at=now() WHERE id IN (SELECT run_id FROM external_author_claims WHERE token_id=$1 AND state='active') AND status='running'`, tokenID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing' WHERE session_id IN (SELECT browser_session_id FROM external_author_claims WHERE token_id=$1 AND state='active') AND NOT reclaimed`, tokenID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE external_author_claims SET state='revoked' WHERE token_id=$1 AND state='active'`, tokenID)
	return err
}
