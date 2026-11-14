package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type interactiveOperation struct {
	Name      string
	RequestID string
	Hash      [32]byte
}

func lockInteractiveToken(ctx context.Context, tx *sql.Tx, token AgentToken) error {
	var workspace string
	var revoked sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT workspace_id,revoked_at FROM agent_tokens WHERE id=$1 FOR UPDATE`, token.ID).Scan(&workspace, &revoked); err != nil || workspace != token.WorkspaceID || revoked.Valid {
		return ErrNotFound
	}
	return nil
}

func requireInteractiveWorkspace(ctx context.Context, tx *sql.Tx, workspace string) error {
	var active bool
	if err := tx.QueryRowContext(ctx, `SELECT lifecycle='active' AND scope_status='confirmed' AND canonical_config IS NOT NULL FROM workspaces WHERE id=$1 FOR SHARE`, workspace).Scan(&active); err != nil {
		return dbError(err)
	}
	if !active {
		return ErrScopeConfirmation
	}
	return nil
}

func priorInteractiveOperation(ctx context.Context, tx *sql.Tx, token AgentToken, op interactiveOperation) (json.RawMessage, error) {
	var hash, result []byte
	err := tx.QueryRowContext(ctx, `SELECT request_hash,result FROM agent_interactive_operations WHERE token_id=$1 AND tool_name=$2 AND request_id=$3`, token.ID, op.Name, op.RequestID).Scan(&hash, &result)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !equalBytes(hash, op.Hash[:]) {
		return nil, ErrConflict
	}
	return json.RawMessage(result), nil
}

func saveInteractiveOperation(ctx context.Context, tx *sql.Tx, token AgentToken, op interactiveOperation, result any) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO agent_interactive_operations(token_id,tool_name,request_id,request_hash,result) VALUES($1,$2,$3,$4,$5)`, token.ID, op.Name, op.RequestID, op.Hash[:], jsonText(result))
	return err
}

func interactiveOp(name, requestID string, canonical []byte) interactiveOperation {
	return interactiveOperation{Name: name, RequestID: requestID, Hash: sha256.Sum256(canonical)}
}

func (p *Postgres) InteractiveDraftCreate(ctx context.Context, token AgentToken, canonical []byte) (any, error) {
	var args struct {
		RequestID, Kind, Name, Description string
		Slug                               *string
	}
	if json.Unmarshal(canonical, &args) != nil || !ValidID(args.RequestID) {
		return nil, ErrInvalid
	}
	if args.Kind != "module" && args.Kind != "usecase" {
		return nil, ErrInvalid
	}
	if (args.Kind == "module" && (args.Slug == nil || !moduleSlug.MatchString(*args.Slug))) || (args.Kind == "usecase" && args.Slug != nil) {
		return nil, ErrInvalid
	}
	args.Name = strings.TrimSpace(args.Name)
	if args.Name == "" || len(args.Name) > 200 || len(args.Description) > 16384 {
		return nil, ErrInvalid
	}
	op := interactiveOp("draft_create", args.RequestID, canonical)
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = lockInteractiveToken(ctx, tx, token); err != nil {
		return nil, err
	}
	if prior, e := priorInteractiveOperation(ctx, tx, token, op); e != nil {
		return nil, e
	} else if prior != nil {
		return prior, tx.Commit()
	}
	if err = requireInteractiveWorkspace(ctx, tx, token.WorkspaceID); err != nil {
		return nil, err
	}
	testID := NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO tests(id,workspace_id,name,description,kind,slug) VALUES($1,$2,$3,$4,$5,$6)`, testID, token.WorkspaceID, args.Name, args.Description, args.Kind, args.Slug); err != nil {
		return nil, err
	}
	session, _, err := startEditingSessionInTx(ctx, tx, testID, "ai")
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO agent_draft_sources(test_id,token_id,workspace_id) VALUES($1,$2,$3)`, testID, token.ID, token.WorkspaceID); err != nil {
		return nil, err
	}
	result := map[string]any{"testId": testID, "editingSessionId": session.ID, "revision": session.Draft.Revision, "contextRevision": session.ContextRevision}
	if err = saveInteractiveOperation(ctx, tx, token, op, result); err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

func (p *Postgres) InteractiveAuthorStart(ctx context.Context, token AgentToken, canonical []byte) (any, error) {
	var args struct {
		RequestID, TestID, EditingSessionID, Instruction string
		Revision                                         int
		ContextRevision                                  int64
	}
	if json.Unmarshal(canonical, &args) != nil || !ValidID(args.RequestID) || !ValidID(args.TestID) || !ValidID(args.EditingSessionID) || args.Revision < 1 || args.ContextRevision < 0 || validateUserMessage(args.Instruction) != nil {
		return nil, ErrInvalid
	}
	op := interactiveOp("author_start", args.RequestID, canonical)
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// A committed replay needs no draft lock. New work follows the established
	// Workspace/Test/Draft -> Token -> Claim order used by submit and platform tools.
	if prior, e := priorInteractiveOperation(ctx, tx, token, op); e != nil {
		return nil, e
	} else if prior != nil {
		if err = lockInteractiveToken(ctx, tx, token); err != nil {
			return nil, err
		}
		result, e := p.replayInteractiveAuthorStart(ctx, tx, token, prior)
		if e != nil {
			return nil, e
		}
		return result, tx.Commit()
	}
	d, session, err := requireEditingDraft(ctx, tx, args.TestID, args.EditingSessionID)
	if err != nil {
		return nil, err
	}
	if err = lockInteractiveToken(ctx, tx, token); err != nil {
		return nil, err
	}
	if prior, e := priorInteractiveOperation(ctx, tx, token, op); e != nil {
		return nil, e
	} else if prior != nil {
		result, e := p.replayInteractiveAuthorStart(ctx, tx, token, prior)
		if e != nil {
			return nil, e
		}
		return result, tx.Commit()
	}
	if err = requireInteractiveWorkspace(ctx, tx, token.WorkspaceID); err != nil {
		return nil, err
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM external_author_claims WHERE token_id=$1 AND state='active')`, token.ID).Scan(&active); err != nil {
		return nil, err
	}
	if active {
		return nil, ErrConflict
	}
	if session.WorkspaceID != token.WorkspaceID || d.ScriptOrigin != "ai" || args.Revision != d.Revision || args.ContextRevision != session.ContextRevision {
		return nil, ErrConflict
	}
	var kind string
	if err = tx.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, args.TestID).Scan(&kind); err != nil {
		return nil, err
	}
	if kind != "module" && kind != "usecase" {
		return nil, ErrConflict
	}
	submission, err := p.createAuthorInTxForEngine(ctx, tx, d, session, args.Instruction, "external")
	if err != nil {
		return nil, err
	}
	var raw []byte
	if err = tx.QueryRowContext(ctx, `SELECT author_payload FROM runs WHERE id=$1 AND workspace_id=$2 AND author_engine='external'`, submission.Run.ID, token.WorkspaceID).Scan(&raw); err != nil {
		return nil, err
	}
	task, err := p.claimExternalRunInTx(ctx, tx, token, args.RequestID, submission.Run.ID, raw)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"task": task}
	var authorizationRevision int64
	if err = tx.QueryRowContext(ctx, `SELECT authorization_revision FROM workspaces WHERE id=$1`, token.WorkspaceID).Scan(&authorizationRevision); err != nil {
		return nil, err
	}
	if err = saveInteractiveOperation(ctx, tx, token, op, map[string]any{"runId": submission.Run.ID, "authorizationRevision": authorizationRevision}); err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

func (p *Postgres) replayInteractiveAuthorStart(ctx context.Context, tx *sql.Tx, token AgentToken, prior json.RawMessage) (any, error) {
	var saved struct {
		RunID                 string `json:"runId"`
		AuthorizationRevision int64  `json:"authorizationRevision"`
	}
	if json.Unmarshal(prior, &saved) != nil || !ValidID(saved.RunID) {
		return nil, ErrInvalid
	}
	if err := requireInteractiveWorkspace(ctx, tx, token.WorkspaceID); err != nil {
		return nil, err
	}
	var currentRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT w.authorization_revision FROM runs r JOIN workspaces w ON w.id=r.workspace_id WHERE r.id=$1 AND r.workspace_id=$2 AND r.author_engine='external'`, saved.RunID, token.WorkspaceID).Scan(&currentRevision); err != nil {
		return nil, dbError(err)
	}
	if saved.AuthorizationRevision != currentRevision {
		return nil, ErrConflict
	}
	c, err := scanExternalClaim(tx.QueryRowContext(ctx, `SELECT `+externalClaimColumns+` FROM external_author_claims WHERE run_id=$1 AND token_id=$2 AND workspace_id=$3`, saved.RunID, token.ID, token.WorkspaceID))
	if err != nil {
		return nil, err
	}
	task, err := p.externalTask(ctx, tx, c)
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task}, nil
}

func (p *Postgres) InteractiveDraftGet(ctx context.Context, token AgentToken, canonical []byte) (any, error) {
	var args struct {
		TestID string `json:"testId"`
	}
	if json.Unmarshal(canonical, &args) != nil || !ValidID(args.TestID) {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	test, err := scanTest(tx.QueryRowContext(ctx, `SELECT `+testColumns+` FROM tests WHERE id=$1 AND workspace_id=$2`, args.TestID, token.WorkspaceID))
	if err != nil {
		return nil, err
	}
	d, err := scanDraft(tx.QueryRowContext(ctx, draftSelect, args.TestID))
	if err != nil {
		return nil, err
	}
	var contextRevision int64
	var sessionStatus string
	if err = tx.QueryRowContext(ctx, `SELECT context_revision,status FROM editing_sessions WHERE id=$1 AND test_id=$2`, d.EditingSessionID, args.TestID).Scan(&contextRevision, &sessionStatus); err != nil {
		return nil, dbError(err)
	}
	var plan any
	if test.Kind == "usecase" {
		item, e := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE test_id=$1 AND editing_session_id=$2`, args.TestID, d.EditingSessionID))
		if e != nil && !errors.Is(e, ErrNotFound) {
			return nil, e
		}
		if e == nil {
			plan = map[string]any{"id": item.ID, "revision": item.Revision, "baseRevision": item.BaseRevision, "contextRevision": item.ContextRevision, "status": item.Status, "stages": item.Stages, "validationRunId": item.ValidationRunID}
		}
	}
	var validation any
	if d.ValidationRunID != nil {
		var status string
		if err = tx.QueryRowContext(ctx, `SELECT status FROM runs WHERE id=$1 AND test_id=$2 AND draft_revision=$3 AND kind='validation'`, *d.ValidationRunID, args.TestID, d.Revision).Scan(&status); err != nil {
			return nil, dbError(err)
		}
		validation = map[string]any{"runId": *d.ValidationRunID, "status": status}
	}
	result := map[string]any{
		"test":           map[string]any{"id": test.ID, "kind": test.Kind, "slug": test.Slug, "name": test.Name, "description": test.Description},
		"draft":          map[string]any{"revision": d.Revision, "script": d.Script, "scriptOrigin": d.ScriptOrigin, "module": d.Module, "stages": d.Stages},
		"editingSession": map[string]any{"id": d.EditingSessionID, "status": sessionStatus, "contextRevision": contextRevision},
		"plan":           plan, "validation": validation,
	}
	return result, tx.Commit()
}

func (p *Postgres) InteractiveValidationRequest(ctx context.Context, token AgentToken, canonical []byte) (any, error) {
	var args struct {
		RequestID, TestID, EditingSessionID string
		Revision                            int
	}
	if json.Unmarshal(canonical, &args) != nil || !ValidID(args.RequestID) || !ValidID(args.TestID) || !ValidID(args.EditingSessionID) || args.Revision < 1 {
		return nil, ErrInvalid
	}
	op := interactiveOp("validation_request", args.RequestID, canonical)
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if prior, e := priorInteractiveOperation(ctx, tx, token, op); e != nil {
		return nil, e
	} else if prior != nil {
		if err = lockInteractiveToken(ctx, tx, token); err != nil {
			return nil, err
		}
		if err = requireInteractiveWorkspace(ctx, tx, token.WorkspaceID); err != nil {
			return nil, err
		}
		if err = checkInteractiveValidationReplay(ctx, tx, token, prior); err != nil {
			return nil, err
		}
		return prior, tx.Commit()
	}
	d, s, err := requireEditingDraft(ctx, tx, args.TestID, args.EditingSessionID)
	if err != nil {
		return nil, err
	}
	if err = lockInteractiveToken(ctx, tx, token); err != nil {
		return nil, err
	}
	if prior, e := priorInteractiveOperation(ctx, tx, token, op); e != nil {
		return nil, e
	} else if prior != nil {
		if err = requireInteractiveWorkspace(ctx, tx, token.WorkspaceID); err != nil {
			return nil, err
		}
		if err = checkInteractiveValidationReplay(ctx, tx, token, prior); err != nil {
			return nil, err
		}
		return prior, tx.Commit()
	}
	if err = requireInteractiveWorkspace(ctx, tx, token.WorkspaceID); err != nil {
		return nil, err
	}
	if s.WorkspaceID != token.WorkspaceID || d.Revision != args.Revision || d.ScriptOrigin != "ai" {
		return nil, ErrConflict
	}
	var kind string
	if err = tx.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, args.TestID).Scan(&kind); err != nil {
		return nil, err
	}
	if kind != "module" && kind != "usecase" {
		return nil, ErrConflict
	}
	if kind == "usecase" {
		plan, e := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE test_id=$1 AND editing_session_id=$2 FOR UPDATE`, args.TestID, args.EditingSessionID))
		if errors.Is(e, ErrNotFound) || (e == nil && (plan.Status == "draft" || plan.Status == "stopped")) {
			return map[string]any{"state": "awaiting_human_plan_confirmation", "runId": nil}, tx.Commit()
		}
		if e != nil {
			return nil, e
		}
		if plan.ValidationRunID == nil {
			return map[string]any{"state": "awaiting_compose", "runId": nil}, tx.Commit()
		}
		if plan.BaseRevision != d.Revision {
			return nil, ErrConflict
		}
		result := map[string]any{"state": "queued", "runId": *plan.ValidationRunID}
		if err = saveInteractiveOperation(ctx, tx, token, op, result); err != nil {
			return nil, err
		}
		return result, tx.Commit()
	}
	if strings.TrimSpace(d.Script) == "" || d.Module == nil {
		return nil, ErrConflict
	}
	if d.ValidationRunID == nil {
		var pending bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM module_validation_requests q JOIN runs r ON r.id=q.source_run_id WHERE q.test_id=$1 AND q.revision=$2 AND NOT q.resolved AND NOT r.slot_released)`, args.TestID, args.Revision).Scan(&pending); err != nil {
			return nil, err
		}
		if pending {
			return map[string]any{"state": "awaiting_reclaim", "runId": nil}, tx.Commit()
		}
		run, e := enqueueValidation(ctx, tx, d)
		if e != nil {
			return nil, e
		}
		d.ValidationRunID = &run.ID
		if _, err = tx.ExecContext(ctx, `UPDATE module_validation_requests SET resolved=true,validation_run_id=$3 WHERE test_id=$1 AND revision=$2 AND NOT resolved`, args.TestID, args.Revision, run.ID); err != nil {
			return nil, err
		}
	}
	result := map[string]any{"state": "queued", "runId": *d.ValidationRunID}
	if err = saveInteractiveOperation(ctx, tx, token, op, result); err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

func checkInteractiveValidationReplay(ctx context.Context, tx *sql.Tx, token AgentToken, prior json.RawMessage) error {
	var saved struct {
		RunID string `json:"runId"`
	}
	if json.Unmarshal(prior, &saved) != nil || !ValidID(saved.RunID) {
		return ErrInvalid
	}
	var current, source sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT w.authorization_revision,r.authorization_revision FROM runs r JOIN workspaces w ON w.id=r.workspace_id WHERE r.id=$1 AND r.workspace_id=$2 AND r.kind='validation'`, saved.RunID, token.WorkspaceID).Scan(&current, &source); err != nil {
		return dbError(err)
	}
	if !current.Valid || !source.Valid || current.Int64 != source.Int64 {
		return ErrConflict
	}
	return nil
}

func (p *Postgres) InteractiveValidationReport(ctx context.Context, token AgentToken, canonical []byte) (any, error) {
	var args struct {
		TestID   string `json:"testId"`
		Revision int    `json:"revision"`
		RunID    string `json:"runId"`
	}
	if json.Unmarshal(canonical, &args) != nil || !ValidID(args.TestID) || !ValidID(args.RunID) || args.Revision < 1 {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var status, attempt string
	if err = tx.QueryRowContext(ctx, `SELECT r.status,COALESCE(r.attempt_id::text,'') FROM runs r JOIN tests t ON t.id=r.test_id JOIN drafts d ON d.test_id=t.id WHERE r.id=$1 AND r.test_id=$2 AND r.draft_revision=$3 AND r.kind='validation' AND t.workspace_id=$4 AND d.current_revision=$3 AND d.validation_run_id=$1`, args.RunID, args.TestID, args.Revision, token.WorkspaceID).Scan(&status, &attempt); err != nil {
		return nil, dbError(err)
	}
	var report any
	if Terminal(status) && attempt != "" {
		data, e := p.readArtifactBytes(ctx, tx, args.RunID, attempt, "results.json", 1<<20)
		if e == nil {
			var body struct {
				Stats  *ValidationStats  `json:"stats"`
				Errors []json.RawMessage `json:"errors"`
			}
			if json.Unmarshal(data, &body) == nil && body.Stats != nil {
				report = map[string]any{"stats": body.Stats, "errorCount": len(body.Errors), "reportsReady": true}
			}
		}
	}
	result := map[string]any{"runId": args.RunID, "revision": args.Revision, "status": status, "report": report}
	return result, tx.Commit()
}

func (a *API) callMCPInteractive(ctx context.Context, p *Postgres, tool ToolDefinition, token AgentToken, canonical []byte) *mcp.CallToolResult {
	var result any
	var err error
	switch tool.Name {
	case "draft_create":
		result, err = p.InteractiveDraftCreate(ctx, token, canonical)
	case "draft_get":
		result, err = p.InteractiveDraftGet(ctx, token, canonical)
	case "author_start":
		result, err = p.InteractiveAuthorStart(ctx, token, canonical)
	case "validation_request":
		result, err = p.InteractiveValidationRequest(ctx, token, canonical)
	case "validation_report":
		result, err = p.InteractiveValidationReport(ctx, token, canonical)
	default:
		return mcpToolError()
	}
	if err != nil {
		return mcpToolError()
	}
	if (tool.Name == "author_start" || tool.Name == "validation_request") && a.engine != nil {
		a.engine.Wake()
	}
	return mcpBrowserResult(result, tool.Limits.MaxOutputBytes)
}
