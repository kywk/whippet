package server

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
)

func platformServerTool(name string) bool {
	switch name {
	case "catalog_search", "catalog_next_page", "catalog_get", "read_module_draft", "read_usecase_draft", "read_plan", "propose_plan":
		return true
	}
	return false
}

// Scope and authorization are checked before the persisted retry result. Run
// locking serializes proposals and cancellation, while the callback checks epoch.
func (p *Postgres) HarnessPlatform(ctx context.Context, manager, run, attempt string, request HarnessToolRequest, registry *ToolRegistry, authorized func() bool) (any, error) {
	return p.harnessPlatform(ctx, run, attempt, request, registry, manager, nil, nil, authorized)
}

func (p *Postgres) HarnessPlatformExternal(ctx context.Context, token AgentToken, claim externalClaim, request HarnessToolRequest, registry *ToolRegistry) (any, error) {
	return p.harnessPlatform(ctx, claim.RunID, claim.AttemptID, request, registry, "", &token, &claim, nil)
}

// Both authorities use the same platform candidate and retry transaction.
// The external path locks its Token and claim before the Run, matching submit.
func (p *Postgres) harnessPlatform(ctx context.Context, run, attempt string, request HarnessToolRequest, registry *ToolRegistry, manager string, token *AgentToken, claim *externalClaim, authorized func() bool) (any, error) {
	if !platformServerTool(request.Name) || !ValidID(request.CallID) || (token == nil && authorized == nil) {
		return nil, ErrInvalid
	}
	tool, ok := registry.tool(request.Name)
	if !ok || tool.Side != "server" {
		return nil, ErrInvalid
	}
	canonical, err := validateToolArguments(tool, request.Arguments)
	if err != nil {
		return nil, err
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var workspace, test, session, kind string
	var raw []byte
	if err = tx.QueryRowContext(ctx, `SELECT workspace_id,test_id,editing_session_id,kind,author_payload FROM runs WHERE id=$1`, run).Scan(&workspace, &test, &session, &kind, &raw); err != nil {
		return nil, ErrHistoryUnavailable
	}
	var input AuthorInput
	if kind != "author" || json.Unmarshal(raw, &input) != nil || input.EditingSessionID != session || validateToolSnapshot(input, registry, request.Name) != nil {
		return nil, ErrHistoryUnavailable
	}
	draft, editing, err := requireEditingDraft(ctx, tx, test, session)
	if err != nil {
		return nil, ErrHistoryUnavailable
	}
	if editing.WorkspaceID != workspace || editing.ConversationID != input.ConversationID || draft.Revision != input.BaseRevision || editing.ContextRevision != input.ContextRevision {
		return nil, ErrHistoryUnavailable
	}
	var testKind string
	if err = tx.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, test).Scan(&testKind); err != nil {
		return nil, err
	}
	if validateAuthorPlatform(input, testKind) != nil {
		return nil, ErrHistoryUnavailable
	}
	if input.SkillID != "module-authoring" && input.SkillID != "usecase-planner" {
		return nil, ErrHistoryUnavailable
	}
	if token != nil {
		current, e := p.lockExternalClaim(ctx, tx, *token, claim.RunID, claim.AttemptID, claim.LeaseID)
		if e != nil || current.WorkspaceID != workspace || p.externalLive(ctx, tx, current) != nil {
			return nil, ErrHistoryUnavailable
		}
	}
	var assigned, currentAttempt sql.NullString
	var status, engine string
	var released bool
	if err = tx.QueryRowContext(ctx, `SELECT manager_id,attempt_id,status,slot_released,author_engine FROM runs WHERE id=$1 FOR UPDATE`, run).Scan(&assigned, &currentAttempt, &status, &released, &engine); err != nil {
		return nil, err
	}
	validAuthority := token != nil && engine == "external" && !assigned.Valid && status == "running"
	if token == nil {
		validAuthority = engine == "builtin" && assigned.String == manager && authorized()
	}
	if !validAuthority || currentAttempt.String != attempt || (token == nil && released) || (status != "running" && status != "dispatched") {
		return nil, ErrHistoryUnavailable
	}
	// Plan-owned Module runs cannot outlive or escape their exact Stage binding.
	if input.Platform.PlanID != nil {
		plan, e := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1`, *input.Platform.PlanID))
		if e != nil {
			return nil, ErrHistoryUnavailable
		}
		if input.SkillID == "usecase-planner" {
			if plan.TestID != test || plan.EditingSessionID != session {
				return nil, ErrHistoryUnavailable
			}
		} else {
			bound := false
			for _, s := range plan.Stages {
				if s.ID == *input.Platform.StageID && s.ModuleTestID == test && s.AuthorRunID != nil && *s.AuthorRunID == run && s.Status == "authoring" {
					bound = true
				}
			}
			if !bound || plan.Status != "running" {
				return nil, ErrHistoryUnavailable
			}
		}
	}
	var nextArgs []byte
	if request.Name == "catalog_next_page" {
		var args struct {
			Cursor string `json:"cursor"`
			Limit  int    `json:"limit"`
		}
		if json.Unmarshal(canonical, &args) != nil {
			return nil, ErrInvalid
		}
		b, e := base64.RawURLEncoding.DecodeString(args.Cursor)
		var cursor catalogToolCursor
		if e != nil || json.Unmarshal(b, &cursor) != nil || cursor.Workspace != workspace || !ValidID(cursor.After) {
			return nil, ErrInvalid
		}
		// Only catalog_search/catalog_next_page produce top-level nextCursor in this table.
		// History pages use harness_history_calls, so no migration or tool-name column is needed.
		var issued bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM platform_tool_calls WHERE run_id=$1 AND attempt_id=$2 AND result->>'nextCursor'=$3)`, run, attempt, args.Cursor).Scan(&issued); err != nil {
			return nil, err
		}
		if !issued {
			return nil, ErrHistoryUnavailable
		}
		nextArgs, _ = json.Marshal(map[string]any{"query": cursor.Query, "limit": args.Limit, "cursor": args.Cursor})
	}
	hash := scriptHash(request.Name + "\n" + string(canonical))
	var priorHash string
	var result json.RawMessage
	err = tx.QueryRowContext(ctx, `SELECT request_hash,result FROM platform_tool_calls WHERE run_id=$1 AND attempt_id=$2 AND call_id=$3`, run, attempt, request.CallID).Scan(&priorHash, &result)
	if err == nil {
		if priorHash != hash || (token == nil && !authorized()) {
			return nil, ErrHistoryUnavailable
		}
		return result, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var calls int
	if err = tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM platform_tool_calls WHERE run_id=$1 AND attempt_id=$2)+(SELECT count(*) FROM harness_history_calls WHERE run_id=$1 AND attempt_id=$2)`, run, attempt).Scan(&calls); err != nil {
		return nil, err
	}
	if calls >= input.Budget.MaxToolCalls {
		return nil, ErrHistoryUnavailable
	}
	var output any
	switch request.Name {
	case "read_module_draft":
		if testKind != "module" {
			return nil, ErrHistoryUnavailable
		}
		module := draft.Module
		if module == nil {
			module = input.Platform.Module
		}
		output = map[string]any{"testId": test, "editingSessionId": session, "revision": draft.Revision, "script": draft.Script, "module": module}
	case "read_usecase_draft":
		if testKind != "usecase" {
			return nil, ErrHistoryUnavailable
		}
		stages := draft.Stages
		if stages == nil {
			stages = []Stage{}
		}
		output = map[string]any{"testId": test, "editingSessionId": session, "revision": draft.Revision, "script": draft.Script, "stages": stages}
	case "read_plan", "propose_plan":
		if testKind != "usecase" {
			return nil, ErrHistoryUnavailable
		}
		if request.Name == "read_plan" {
			plan, e := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE test_id=$1 AND editing_session_id=$2`, test, session))
			if e != nil && !errors.Is(e, ErrNotFound) {
				return nil, e
			}
			output = map[string]any{"plan": plan}
		} else {
			var args struct {
				Stages []PlanStageInput `json:"stages"`
			}
			if json.Unmarshal(canonical, &args) != nil {
				return nil, ErrInvalid
			}
			prepared, e := preparePlanStages(ctx, tx, workspace, args.Stages)
			if e != nil {
				return nil, e
			}
			stages := make([]PlanStageInput, len(prepared))
			for i, s := range prepared {
				stages[i] = s.PlanStageInput
			}
			encoded, e := json.Marshal(stages)
			if e != nil {
				return nil, e
			}
			ref := NewID()
			if _, e = tx.ExecContext(ctx, `INSERT INTO plan_candidates(id,run_id,attempt_id,editing_session_id,base_revision,context_revision,content_hash,stages) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, ref, run, attempt, session, input.BaseRevision, input.ContextRevision, scriptHash(string(encoded)), string(encoded)); e != nil {
				return nil, e
			}
			output = map[string]any{"candidate": true, "candidateRef": ref, "stages": stages}
		}
	case "catalog_get":
		var args struct {
			ModuleVersionID string `json:"moduleVersionId"`
		}
		json.Unmarshal(canonical, &args)
		var id, version, script, origin string
		var module json.RawMessage
		if err = tx.QueryRowContext(ctx, `SELECT t.id,v.id,v.script,v.script_origin,v.module FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.id=$1 AND t.workspace_id=$2 AND t.kind='module' AND v.module IS NOT NULL`, args.ModuleVersionID, workspace).Scan(&id, &version, &script, &origin, &module); err != nil {
			return nil, ErrHistoryUnavailable
		}
		output = map[string]any{"testId": id, "versionId": version, "script": script, "scriptOrigin": origin, "module": module}
	case "catalog_next_page":
		output, err = searchToolCatalog(ctx, tx, workspace, nextArgs)
		if err != nil {
			return nil, err
		}
	case "catalog_search":
		output, err = searchToolCatalog(ctx, tx, workspace, canonical)
		if err != nil {
			return nil, err
		}
	}
	result, err = json.Marshal(output)
	if err != nil || len(result) > tool.Limits.MaxOutputBytes {
		return nil, ErrHistoryUnavailable
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO platform_tool_calls(run_id,attempt_id,call_id,request_hash,result) VALUES($1,$2,$3,$4,$5)`, run, attempt, request.CallID, hash, string(result)); err != nil {
		return nil, err
	}
	if token == nil && !authorized() {
		return nil, ErrHistoryUnavailable
	}
	return result, tx.Commit()
}

type catalogToolCursor struct{ Workspace, Query, After string }

func searchToolCatalog(ctx context.Context, tx *sql.Tx, workspace string, raw []byte) (any, error) {
	var args struct {
		Query  string  `json:"query"`
		Limit  int     `json:"limit"`
		Cursor *string `json:"cursor"`
	}
	if json.Unmarshal(raw, &args) != nil {
		return nil, ErrInvalid
	}
	after := "00000000-0000-0000-0000-000000000000"
	if args.Cursor != nil {
		b, e := base64.RawURLEncoding.DecodeString(*args.Cursor)
		var c catalogToolCursor
		if e != nil || json.Unmarshal(b, &c) != nil || c.Workspace != workspace || c.Query != args.Query || !ValidID(c.After) {
			return nil, ErrInvalid
		}
		after = c.After
	}
	rows, err := tx.QueryContext(ctx, `SELECT t.id,v.id,t.name,v.module FROM tests t JOIN test_versions v ON v.id=t.published_version_id WHERE t.workspace_id=$1 AND t.kind='module' AND v.module IS NOT NULL AND t.id>$2::uuid AND (strpos(lower(t.name),lower($3))>0 OR strpos(lower(t.slug),lower($3))>0) ORDER BY t.id LIMIT $4`, workspace, after, args.Query, args.Limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	var next *string
	for rows.Next() {
		var id, version, name string
		var module json.RawMessage
		if err = rows.Scan(&id, &version, &name, &module); err != nil {
			return nil, err
		}
		if len(items) == args.Limit {
			b, _ := json.Marshal(catalogToolCursor{workspace, args.Query, after})
			c := base64.RawURLEncoding.EncodeToString(b)
			next = &c
			break
		}
		items = append(items, map[string]any{"testId": id, "versionId": version, "name": name, "module": module})
		after = id
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"items": items, "nextCursor": next}, nil
}
