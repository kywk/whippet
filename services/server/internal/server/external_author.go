package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

const externalLeaseDuration = 120 * time.Second
const externalAdapterInstructions = "External MCP adapter: submit a complete Test script with task_submit. This candidate has NOT passed Worker self-test. requestValidation only schedules an independent formal validation Run; inspect its result before treating the draft as validated. Do not send partial, selfTestPassed, validated, or proof."
const externalSummaryInstructions = "External MCP adapter: summarize only the pinned validation evidence with task_submit. Return message, description, backgroundSummary, and optional name. Do not claim untested behavior, supply proof, run tools, request validation, or publish. Server checks current evidence and revision before accepting the summary."
const externalModuleInstructions = "External MCP adapter: submit a complete Module script and module metadata as an untested AI candidate. requestValidation queues independent platform validation and harness evidence; do not claim Worker self-test or supply proof."
const externalPlannerInstructions = "External MCP adapter: call task_tool_call(propose_plan) first, then submit only the Server-issued candidateRef from this Run and attempt. Never submit stages directly or claim validation."
const externalWorkspaceInstructions = "External MCP adapter: submit an interview message and optional Workspace proposal. The proposal needs human scope confirmation; no browser access without an already confirmed scope."

var externalConnectedTools = []string{"read_draft", "read_validation_report", "read_module_draft", "read_usecase_draft", "read_plan", "catalog_search", "catalog_next_page", "catalog_get", "propose_plan", "read_conversation_history", "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_login"}

type ExternalTaskBundle struct {
	Author               AuthorInput        `json:"author"`
	Script               string             `json:"script"`
	WorkspaceSettings    *WorkspaceSettings `json:"workspaceSettings"`
	WorkspaceContext     *WorkspaceContext  `json:"workspaceContext"`
	SkillURI             string             `json:"skillUri"`
	ExternalReferenceURI string             `json:"externalReferenceUri,omitempty"`
	Instructions         string             `json:"instructions"`
}
type ExternalTask struct {
	RunID         string             `json:"runId"`
	AttemptID     string             `json:"attemptId"`
	LeaseID       string             `json:"leaseId"`
	State         string             `json:"state"`
	ExpiresAt     time.Time          `json:"expiresAt"`
	DeadlineAt    time.Time          `json:"deadlineAt"`
	ContextBundle ExternalTaskBundle `json:"contextBundle"`
}
type ExternalSubmitResult struct {
	State           string  `json:"state"`
	AppliedRevision *int    `json:"appliedRevision"`
	ValidationRunID *string `json:"validationRunId"`
}
type externalClaim struct {
	RunID, AttemptID, LeaseID, TokenID, WorkspaceID, State string
	ExpiresAt, DeadlineAt                                  time.Time
	ContextRevision                                        int64
	AllowedTools                                           []string
	BrowserSessionID                                       *string
	SubmitID                                               *string
	SubmitHash                                             []byte
	Result                                                 []byte
}

const externalClaimColumns = `run_id,attempt_id,lease_id,token_id,workspace_id,state,expires_at,deadline_at,context_revision,allowed_tools,browser_session_id,submit_id,submit_hash,result`

func scanExternalClaim(row scanner) (externalClaim, error) {
	var c externalClaim
	var tools, result []byte
	err := row.Scan(&c.RunID, &c.AttemptID, &c.LeaseID, &c.TokenID, &c.WorkspaceID, &c.State, &c.ExpiresAt, &c.DeadlineAt, &c.ContextRevision, &tools, &c.BrowserSessionID, &c.SubmitID, &c.SubmitHash, &result)
	if err != nil {
		return c, dbError(err)
	}
	if json.Unmarshal(tools, &c.AllowedTools) != nil {
		return c, ErrInvalid
	}
	c.Result = result
	return c, nil
}

func externalTools(input AuthorInput) []string {
	enabled := map[string]bool{}
	for _, name := range input.AllowedTools {
		enabled[name] = true
	}
	out := []string{}
	for _, name := range externalConnectedTools {
		if enabled[name] {
			out = append(out, name)
		}
	}
	return out
}

func scrubExternalContext(c *WorkspaceContext) *WorkspaceContext {
	if c == nil {
		return nil
	}
	clone := *c
	clone.RoleRefs = append([]RoleRef(nil), c.RoleRefs...)
	for i := range clone.RoleRefs {
		clone.RoleRefs[i].SecretRef = nil
		clone.RoleRefs[i].SecretVersion = nil
	}
	return &clone
}

func (p *Postgres) externalTask(ctx context.Context, q queryDB, c externalClaim) (ExternalTask, error) {
	var rawAuthor, rawSettings, rawContext []byte
	var script string
	err := q.QueryRowContext(ctx, `SELECT author_payload,script_snapshot,workspace_settings,workspace_context FROM runs WHERE id=$1 AND attempt_id=$2 AND workspace_id=$3`, c.RunID, c.AttemptID, c.WorkspaceID).Scan(&rawAuthor, &script, &rawSettings, &rawContext)
	if err != nil {
		return ExternalTask{}, dbError(err)
	}
	var input AuthorInput
	if json.Unmarshal(rawAuthor, &input) != nil || (input.SkillID != "test-author" && input.SkillID != "acceptance-summary" && input.SkillID != "module-authoring" && input.SkillID != "usecase-planner" && input.SkillID != "workspace-author") || input.Budget == nil {
		return ExternalTask{}, ErrInvalid
	}
	if len(input.Skills) == 0 || input.Skills[0].ID != input.SkillID || input.Skills[0].ReferenceHashes["external-mcp"] == "" {
		return ExternalTask{}, ErrInvalid
	}
	input.AllowedTools = c.AllowedTools
	settings, err := decodeSettings(rawSettings)
	if err != nil {
		return ExternalTask{}, err
	}
	wc, err := decodeWorkspaceContext(rawContext)
	if err != nil {
		return ExternalTask{}, err
	}
	bundle := ExternalTaskBundle{Author: input, Script: script, WorkspaceSettings: settings, WorkspaceContext: scrubExternalContext(wc), SkillURI: "whippet://skill/" + input.SkillID + "/main"}
	if input.SkillID == "acceptance-summary" {
		if len(c.AllowedTools) != 0 || len(input.Skills) == 0 || input.Skills[0].ReferenceHashes["external-mcp"] == "" {
			return ExternalTask{}, ErrInvalid
		}
		bundle.ExternalReferenceURI = "whippet://skill/acceptance-summary/references/external-mcp"
		bundle.Instructions = externalSummaryInstructions
	} else if input.SkillID == "module-authoring" {
		bundle.ExternalReferenceURI = "whippet://skill/module-authoring/references/external-mcp"
		bundle.Instructions = externalModuleInstructions
	} else if input.SkillID == "usecase-planner" {
		bundle.ExternalReferenceURI = "whippet://skill/usecase-planner/references/external-mcp"
		bundle.Instructions = externalPlannerInstructions
	} else if input.SkillID == "workspace-author" {
		bundle.ExternalReferenceURI = "whippet://skill/workspace-author/references/external-mcp"
		bundle.Instructions = externalWorkspaceInstructions
	} else {
		bundle.ExternalReferenceURI = "whippet://skill/test-author/references/external-mcp"
		bundle.Instructions = externalAdapterInstructions
	}
	return ExternalTask{RunID: c.RunID, AttemptID: c.AttemptID, LeaseID: c.LeaseID, State: c.State, ExpiresAt: c.ExpiresAt, DeadlineAt: c.DeadlineAt, ContextBundle: bundle}, nil
}

func (p *Postgres) ClaimExternalAuthor(ctx context.Context, token AgentToken, requestID string) (*ExternalTask, error) {
	if !ValidID(requestID) {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var workspace string
	var revoked sql.NullTime
	if err = tx.QueryRowContext(ctx, `SELECT workspace_id,revoked_at FROM agent_tokens WHERE id=$1 FOR UPDATE`, token.ID).Scan(&workspace, &revoked); err != nil || workspace != token.WorkspaceID || revoked.Valid {
		return nil, ErrNotFound
	}
	c, err := scanExternalClaim(tx.QueryRowContext(ctx, `SELECT `+externalClaimColumns+` FROM external_author_claims WHERE token_id=$1 AND request_id=$2`, token.ID, requestID))
	if err == nil {
		task, e := p.externalTask(ctx, tx, c)
		if e != nil {
			return nil, e
		}
		return &task, tx.Commit()
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM external_author_claims WHERE token_id=$1 AND state='active')`, token.ID).Scan(&active); err != nil {
		return nil, err
	}
	if active {
		return nil, ErrConflict
	}
	var runID string
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT r.id,r.author_payload FROM runs r WHERE r.workspace_id=$1 AND r.kind='author' AND r.author_engine='external' AND r.status='queued' AND r.author_payload->>'skillId' IN ('test-author','acceptance-summary','module-authoring','usecase-planner','workspace-author') ORDER BY r.queue_seq FOR UPDATE OF r SKIP LOCKED LIMIT 1`, token.WorkspaceID).Scan(&runID, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, tx.Commit()
	}
	if err != nil {
		return nil, err
	}
	task, err := p.claimExternalRunInTx(ctx, tx, token, requestID, runID, raw)
	if err != nil {
		return nil, err
	}
	return task, tx.Commit()
}

// The caller holds the Agent Token row lock and has selected exactly this Run.
func (p *Postgres) claimExternalRunInTx(ctx context.Context, tx *sql.Tx, token AgentToken, requestID, runID string, raw []byte) (*ExternalTask, error) {
	var input AuthorInput
	if json.Unmarshal(raw, &input) != nil || input.Budget == nil || (input.EditingSessionID == "" && input.SkillID != "workspace-author") {
		return nil, ErrInvalid
	}
	contextRevision := input.ContextRevision
	maxDuration := input.Budget.MaxDurationMS
	if maxDuration < 1 || maxDuration > 1800000 {
		return nil, ErrInvalid
	}
	var current int64
	var sessionStatus string
	if input.SkillID == "workspace-author" {
		err := tx.QueryRowContext(ctx, `SELECT c.context_revision,w.lifecycle FROM conversations c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=$1 AND c.workspace_id=$2 AND c.owner_type='workspace'`, input.ConversationID, token.WorkspaceID).Scan(&current, &sessionStatus)
		if err != nil {
			return nil, dbError(err)
		}
	} else {
		err := tx.QueryRowContext(ctx, `SELECT e.context_revision,e.status FROM editing_sessions e JOIN tests t ON t.id=e.test_id WHERE e.id=$1 AND t.workspace_id=$2`, input.EditingSessionID, token.WorkspaceID).Scan(&current, &sessionStatus)
		if err != nil {
			return nil, dbError(err)
		}
	}
	if current != contextRevision || (input.SkillID != "workspace-author" && sessionStatus != "active") || (input.SkillID == "workspace-author" && sessionStatus == "archived") {
		return nil, ErrConflict
	}
	now := time.Now().UTC()
	deadline := now.Add(time.Duration(maxDuration) * time.Millisecond)
	expires := now.Add(externalLeaseDuration)
	if expires.After(deadline) {
		expires = deadline
	}
	c := externalClaim{RunID: runID, AttemptID: NewID(), LeaseID: NewID(), TokenID: token.ID, WorkspaceID: token.WorkspaceID, State: "active", ExpiresAt: expires, DeadlineAt: deadline, ContextRevision: contextRevision, AllowedTools: externalTools(input)}
	result, err := tx.ExecContext(ctx, `UPDATE runs SET status='running',attempt_id=$2,started_at=now() WHERE id=$1 AND status='queued' AND author_engine='external' AND workspace_id=$3`, runID, c.AttemptID, token.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		return nil, ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO external_author_claims(run_id,attempt_id,lease_id,token_id,workspace_id,request_id,state,expires_at,deadline_at,context_revision,allowed_tools) VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10)`, c.RunID, c.AttemptID, c.LeaseID, c.TokenID, c.WorkspaceID, requestID, c.ExpiresAt, c.DeadlineAt, c.ContextRevision, jsonText(c.AllowedTools)); err != nil {
		return nil, err
	}
	task, err := p.externalTask(ctx, tx, c)
	if err != nil {
		return nil, err
	}
	return &task, nil
}

func (p *Postgres) lockExternalClaim(ctx context.Context, tx *sql.Tx, token AgentToken, runID, attemptID, leaseID string) (externalClaim, error) {
	var revoked sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT revoked_at FROM agent_tokens WHERE id=$1 AND workspace_id=$2 FOR SHARE`, token.ID, token.WorkspaceID).Scan(&revoked); err != nil || revoked.Valid {
		return externalClaim{}, ErrNotFound
	}
	c, err := scanExternalClaim(tx.QueryRowContext(ctx, `SELECT `+externalClaimColumns+` FROM external_author_claims WHERE run_id=$1 AND attempt_id=$2 AND lease_id=$3 AND token_id=$4 AND workspace_id=$5 FOR UPDATE`, runID, attemptID, leaseID, token.ID, token.WorkspaceID))
	if err != nil {
		return c, err
	}
	return c, nil
}

func (p *Postgres) externalLive(ctx context.Context, tx *sql.Tx, c externalClaim) error {
	if c.State != "active" || !time.Now().Before(c.ExpiresAt) || !time.Now().Before(c.DeadlineAt) {
		return ErrConflict
	}
	var raw []byte
	if err := tx.QueryRowContext(ctx, `SELECT author_payload FROM runs WHERE id=$1 AND workspace_id=$2`, c.RunID, c.WorkspaceID).Scan(&raw); err != nil {
		return dbError(err)
	}
	var input AuthorInput
	if json.Unmarshal(raw, &input) != nil {
		return ErrInvalid
	}
	if input.SkillID == "workspace-author" {
		var status, engine string
		var attempt *string
		var revision int
		var contextRevision int64
		err := tx.QueryRowContext(ctx, `SELECT r.status,r.attempt_id,r.author_engine,(w.settings->>'revision')::integer,c.context_revision FROM runs r JOIN workspaces w ON w.id=r.workspace_id JOIN conversations c ON c.id=(r.author_payload->>'conversationId')::uuid AND c.workspace_id=w.id AND c.owner_type='workspace' WHERE r.id=$1 AND r.workspace_id=$2 AND r.test_id IS NULL FOR UPDATE OF r`, c.RunID, c.WorkspaceID).Scan(&status, &attempt, &engine, &revision, &contextRevision)
		if err != nil {
			return dbError(err)
		}
		if status != "running" || engine != "external" || attempt == nil || *attempt != c.AttemptID || revision != input.BaseRevision || contextRevision != c.ContextRevision {
			return ErrConflict
		}
		if hasBrowserTools(&input) {
			w, pid, e := readWorkspaceCore(ctx, tx, c.WorkspaceID, false)
			if e != nil {
				return e
			}
			w, e = fillWorkspace(ctx, tx, w, pid, false)
			if e != nil || !workspaceRunScopeValid(ctx, tx, w, c.RunID) {
				return ErrConflict
			}
		}
		return nil
	}
	var status, sessionStatus, origin string
	var attempt *string
	var revision int64
	err := tx.QueryRowContext(ctx, `SELECT r.status,r.attempt_id,e.status,e.context_revision,r.script_origin FROM runs r JOIN editing_sessions e ON e.id=r.editing_session_id WHERE r.id=$1 AND r.workspace_id=$2 AND r.author_engine='external' FOR UPDATE OF r`, c.RunID, c.WorkspaceID).Scan(&status, &attempt, &sessionStatus, &revision, &origin)
	if err != nil {
		return dbError(err)
	}
	if status != "running" || attempt == nil || *attempt != c.AttemptID || sessionStatus != "active" || revision != c.ContextRevision {
		return ErrConflict
	}
	return nil
}

func (p *Postgres) HeartbeatExternalAuthor(ctx context.Context, token AgentToken, runID, attemptID, leaseID string) (map[string]any, error) {
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
	expires := time.Now().UTC().Add(externalLeaseDuration)
	if expires.After(c.DeadlineAt) {
		expires = c.DeadlineAt
	}
	if _, err = tx.ExecContext(ctx, `UPDATE external_author_claims SET expires_at=$2 WHERE run_id=$1`, runID, expires); err != nil {
		return nil, err
	}
	return map[string]any{"state": "active", "expiresAt": expires, "deadlineAt": c.DeadlineAt}, tx.Commit()
}

func externalOutputHash(data []byte) ([32]byte, error) {
	var v any
	if strictJSONNoDuplicates(data) != nil || json.Unmarshal(data, &v) != nil {
		return [32]byte{}, ErrInvalid
	}
	canonical, err := json.Marshal(v)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(canonical), nil
}

func (p *Postgres) validateExternalAuthorSubmission(ctx context.Context, token AgentToken, runID string, raw []byte) (string, error) {
	var testID sql.NullString
	var skillID string
	err := p.DB.QueryRowContext(ctx, `SELECT test_id,author_payload->>'skillId' FROM runs WHERE id=$1 AND workspace_id=$2 AND author_engine='external' AND kind='author'`, runID, token.WorkspaceID).Scan(&testID, &skillID)
	if err != nil {
		return "", dbError(err)
	}
	if strictJSONNoDuplicates(raw) != nil {
		return "", ErrInvalid
	}
	switch skillID {
	case "test-author":
		_, err = decodeExternalAuthorOutput(raw)
	case "acceptance-summary":
		_, err = decodeExternalSummaryOutput(raw)
	case "module-authoring", "usecase-planner":
		var inputRaw []byte
		if err = p.DB.QueryRowContext(ctx, `SELECT author_payload FROM runs WHERE id=$1 AND workspace_id=$2`, runID, token.WorkspaceID).Scan(&inputRaw); err != nil {
			break
		}
		var input AuthorInput
		if json.Unmarshal(inputRaw, &input) != nil {
			err = ErrInvalid
			break
		}
		registry, e := loadToolRegistry()
		if e != nil {
			err = e
			break
		}
		if skillID == "module-authoring" {
			_, err = decodeModuleAuthorOutput(raw, input, registry)
		} else {
			_, err = decodePlannerAuthorOutput(raw, input, registry)
		}
	case "workspace-author":
		_, err = decodeWorkspaceAuthorOutput(raw)
	default:
		err = ErrInvalid
	}
	return testID.String, err
}

func (p *Postgres) SubmitExternalAuthor(ctx context.Context, token AgentToken, runID, attemptID, leaseID, submitID string, raw []byte) (ExternalSubmitResult, error) {
	if !ValidID(submitID) {
		return ExternalSubmitResult{}, ErrInvalid
	}
	testID, err := p.validateExternalAuthorSubmission(ctx, token, runID, raw)
	if err != nil {
		return ExternalSubmitResult{}, err
	}
	hash, err := externalOutputHash(raw)
	if err != nil {
		return ExternalSubmitResult{}, err
	}
	var result ExternalSubmitResult
	lock := func(tx *sql.Tx) (string, error) {
		c, e := p.lockExternalClaim(ctx, tx, token, runID, attemptID, leaseID)
		if e != nil {
			return "", e
		}
		if c.State == "submitted" {
			if c.SubmitID == nil || *c.SubmitID != submitID || len(c.SubmitHash) != len(hash) || !equalBytes(c.SubmitHash, hash[:]) {
				return "", ErrConflict
			}
			if json.Unmarshal(c.Result, &result) != nil {
				return "", ErrInvalid
			}
			return "succeeded", nil
		}
		if e = p.externalLive(ctx, tx, c); e != nil {
			return "", e
		}
		if c.BrowserSessionID != nil {
			var reclaimed bool
			e = tx.QueryRowContext(ctx, `SELECT reclaimed FROM agent_browser_leases WHERE session_id=$1`, *c.BrowserSessionID).Scan(&reclaimed)
			if e != nil || !reclaimed {
				return "", ErrConflict
			}
		}
		return "running", nil
	}
	finish := func(tx *sql.Tx) error {
		result.State = "submitted"
		var applied sql.NullInt64
		var validation *string
		e := tx.QueryRowContext(ctx, `SELECT applied_revision,validation_run_id FROM messages WHERE run_id=$1 AND role='assistant' ORDER BY sequence DESC LIMIT 1`, runID).Scan(&applied, &validation)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		if applied.Valid {
			v := int(applied.Int64)
			result.AppliedRevision = &v
		}
		result.ValidationRunID = validation
		_, e = tx.ExecContext(ctx, `UPDATE external_author_claims SET state='submitted',submit_id=$2,submit_hash=$3,result=$4 WHERE run_id=$1 AND state='active'`, runID, submitID, hash[:], jsonText(result))
		return e
	}
	if testID == "" {
		err = p.completeWorkspaceAuthorWith(ctx, token.WorkspaceID, runID, attemptID, Result{Status: "succeeded"}, lock, raw, finish)
	} else {
		err = p.completeAuthorWith(ctx, testID, runID, attemptID, Result{Status: "succeeded"}, lock, raw, finish)
	}
	return result, err
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
