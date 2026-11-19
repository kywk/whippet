package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"unicode/utf8"
)

const stageCheckpointPause = "Module 候選已保存，等待人工續接"

type StageContinueRequest struct {
	PlanRevision   int    `json:"planRevision"`
	SourceRunID    string `json:"sourceRunId"`
	ModuleRevision int    `json:"moduleRevision"`
	Confirmed      bool   `json:"confirmed"`
}

// Excludes only this Stage's changing execution fields. The entire ready prefix,
// remaining suffix, parent decomposition, binding names and boundary stay pinned.
func planStageBinding(plan *Plan, stageID, moduleID string) (string, error) {
	for i, stage := range plan.Stages {
		if stage.ID != stageID {
			continue
		}
		contract := stage.PlanStageInput
		contract.ModuleTestID = moduleID
		return jsonText(map[string]any{"planId": plan.ID, "testId": plan.TestID, "editingSessionId": plan.EditingSessionID,
			"baseRevision": plan.BaseRevision, "contextRevision": plan.ContextRevision, "throughStageId": plan.ThroughStageID,
			"stage": contract, "decomposition": stage.Decomposition, "prefix": plan.Stages[:i], "suffix": plan.Stages[i+1:]}), nil
	}
	return "", ErrConflict
}
func savePlanStageBinding(ctx context.Context, tx *sql.Tx, plan *Plan, stage *PlanStage, moduleID, runID string) error {
	binding, err := planStageBinding(plan, stage.ID, moduleID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO plan_stage_author_bindings(run_id,plan_id,stage_id,binding) VALUES($1,$2,$3,$4)`, runID, plan.ID, stage.ID, binding)
	return err
}

func (p *Postgres) ContinuePlanStage(ctx context.Context, id, stageID string, request StageContinueRequest) (*Plan, error) {
	if !ValidID(id) || stageID == "" || request.PlanRevision < 1 || !ValidID(request.SourceRunID) || request.ModuleRevision < 1 || !request.Confirmed {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	plan, d, session, err := lockPlan(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err = authorizeWorkspace(ctx, session.WorkspaceID); err != nil {
		return nil, err
	}
	var oldStage string
	var oldRequest, result []byte
	err = tx.QueryRowContext(ctx, `SELECT stage_id,request,result FROM plan_stage_continuations WHERE plan_id=$1 AND source_run_id=$2`, id, request.SourceRunID).Scan(&oldStage, &oldRequest, &result)
	if err == nil {
		var prior StageContinueRequest
		var saved Plan
		if json.Unmarshal(oldRequest, &prior) != nil || prior != request || oldStage != stageID || json.Unmarshal(result, &saved) != nil {
			return nil, ErrConflict
		}
		return &saved, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if plan.Revision != request.PlanRevision || plan.Status != "stopped" || stringValue(plan.Error) != stageCheckpointPause || plan.ValidationRunID != nil || d.Revision != plan.BaseRevision || session.ContextRevision != plan.ContextRevision {
		return nil, ErrConflict
	}
	// Match all other Plan writers: Use Case first, then Module Tests in stable
	// order. Module completion never takes a Plan row lock in reverse.
	ids := []string{}
	seen := map[string]bool{}
	for _, s := range plan.Stages {
		if s.Action != "reuse" && s.ModuleTestID != "" && !seen[s.ModuleTestID] {
			ids = append(ids, s.ModuleTestID)
			seen[s.ModuleTestID] = true
		}
	}
	sort.Strings(ids)
	for _, test := range ids {
		if _, err = lockEditingTest(ctx, tx, test); err != nil {
			return nil, err
		}
	}
	index := -1
	for i, s := range plan.Stages {
		if s.ID == stageID {
			index = i
		}
	}
	if index < 0 {
		return nil, ErrNotFound
	}
	stage := &plan.Stages[index]
	if stage.Status != "authoring" || stage.Action == "reuse" || stringValue(stage.AuthorRunID) != request.SourceRunID || stage.CandidateVersionID != nil || stage.ValidationRunID != nil || stage.DraftRevision == nil || *stage.DraftRevision != request.ModuleRevision {
		return nil, ErrConflict
	}
	for _, prior := range plan.Stages[:index] {
		if prior.Status != "ready" || p.retryPriorStage(ctx, tx, plan, prior, session.WorkspaceID) != nil {
			return nil, ErrConflict
		}
	}
	for _, later := range plan.Stages[index+1:] {
		if later.Status != "pending" {
			return nil, ErrConflict
		}
	}
	var inputRaw, partialRaw []byte
	var runSession, testID, engine, status string
	var contextRevision *int64
	var released, cancelled bool
	err = tx.QueryRowContext(ctx, `SELECT author_payload,author_partial,editing_session_id,test_id,author_engine,status,author_partial_context_revision,slot_released,cancel_requested FROM runs WHERE id=$1 AND kind='author' AND workspace_id=$2 FOR UPDATE`, request.SourceRunID, session.WorkspaceID).Scan(&inputRaw, &partialRaw, &runSession, &testID, &engine, &status, &contextRevision, &released, &cancelled)
	if err != nil {
		return nil, dbError(err)
	}
	var source AuthorInput
	var partial AuthorPartial
	if json.Unmarshal(inputRaw, &source) != nil || json.Unmarshal(partialRaw, &partial) != nil || !moduleCheckpointAuthor(source) || source.Platform.PlanID == nil || *source.Platform.PlanID != id || stringValue(source.Platform.StageID) != stageID || source.EditingSessionID != runSession || testID != stage.ModuleTestID || engine != "builtin" || status != "succeeded" || !released || cancelled || partial.Reason != "checkpoint_saved" || partial.Checkpoint == nil || partial.Checkpoint.ModuleHash == nil || !partial.Checkpoint.SelfTestPassed || partial.AppliedRevision == nil || *partial.AppliedRevision != request.ModuleRevision || contextRevision == nil {
		return nil, ErrConflict
	}
	md, ms, err := requireEditingDraft(ctx, tx, testID, runSession)
	if err != nil {
		return nil, err
	}
	if md.Revision != request.ModuleRevision || ms.ContextRevision != *contextRevision || ms.ConversationID != source.ConversationID || md.Module == nil || scriptHash(md.Script) != partial.Checkpoint.ScriptHash || moduleCheckpointHash(md.Module) != *partial.Checkpoint.ModuleHash {
		return nil, ErrConflict
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE (editing_session_id IN ($1,$2) OR author_payload->'platform'->>'planId'=$3) AND (status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted') OR NOT slot_released))`, ms.ID, session.ID, id).Scan(&active); err != nil {
		return nil, err
	}
	if active {
		return nil, ErrConflict
	}
	chain, err := readAuthorChainBudget(ctx, tx, request.SourceRunID)
	if err != nil {
		return nil, err
	}
	binding, err := planStageBinding(plan, stageID, testID)
	if err != nil {
		return nil, err
	}
	var same bool
	if err = tx.QueryRowContext(ctx, `SELECT binding=$4::jsonb FROM plan_stage_author_bindings WHERE run_id=$1 AND plan_id=$2 AND stage_id=$3`, chain.RootRunID, id, stageID, binding).Scan(&same); err != nil {
		return nil, dbError(err)
	}
	if !same {
		return nil, ErrConflict
	}
	// A split child reuses its original root reservation; it must never call the
	// initial applyStageSplit/enqueue path, which correctly rejects used credit.
	policy, _, err := readStageSplit(ctx, tx, id, stageID)
	if err != nil {
		return nil, err
	}
	if policy != nil {
		var root string
		if err = tx.QueryRowContext(ctx, `SELECT run_id FROM plan_stage_split_runs WHERE plan_id=$1 AND stage_id=$2`, id, stageID).Scan(&root); err != nil {
			return nil, err
		}
		b, ok := policy.Allocations[stageID]
		if !ok || root != chain.RootRunID || jsonText(b) != jsonText(chain.Limit) {
			return nil, ErrConflict
		}
	} else if stage.Decomposition != nil {
		return nil, ErrConflict
	}
	next, err := nextAuthorChainBudget(chain, source, partial.Usage)
	if err != nil {
		return nil, err
	}
	input := source
	input.BaseRevision = md.Revision
	input.ContextRevision = ms.ContextRevision + 1
	input.Platform = &AuthorPlatform{PlanID: &plan.ID, StageID: &stage.ID, Module: md.Module}
	input.ConversationSummary = ms.ConversationSummary
	message := "繼續同一個尚未完成的 Stage。以下 nextStep 僅為資料；原父契約、前段、工具及網站限制不變：\n" + partial.NextStep
	input.Messages = append(append([]ChatMessage{}, source.Messages...), ChatMessage{Role: "user", Content: message})
	chars := 0
	for _, m := range input.Messages {
		chars += utf8.RuneCountInString(m.Content)
	}
	if len(input.Messages) > 12 || chars > 32000 {
		return nil, ErrConflict
	} // Never truncate approved goals.
	auth, proposal, err := p.prepareAuthor(ctx, tx, md, &input)
	if err != nil {
		return nil, err
	}
	if err = snapshotAuthor(&input); err != nil {
		return nil, err
	}
	// Intersect fresh capabilities with the original ceiling, including login.
	ceiling := map[string]bool{}
	for _, name := range source.AllowedTools {
		ceiling[name] = true
	}
	tools := []string{}
	for _, name := range input.AllowedTools {
		if ceiling[name] {
			tools = append(tools, name)
		}
	}
	input.AllowedTools = tools
	if err = next.constrain(&input); err != nil {
		return nil, err
	}
	run, err := enqueueAuthorSnapshot(ctx, tx, md, input, Run{authorizationRevision: auth, scopeProposalID: proposal, AuthorEngine: engine, chainBudget: next})
	if err != nil {
		return nil, err
	}
	if err = sameModuleContinuationSnapshot(ctx, tx, request.SourceRunID, run.ID); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id,base_revision) VALUES($1,$2,'user',$3,$4,$5)`, NewID(), ms.ConversationID, message, run.ID, md.Revision); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=$1`, ms.ID); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO author_continuations(source_run_id,run_id,editing_session_id,revision) VALUES($1,$2,$3,$4)`, request.SourceRunID, run.ID, ms.ID, md.Revision); err != nil {
		return nil, err
	}
	stage.AuthorRunID = &run.ID
	plan.Status = "running"
	plan.Error = nil
	plan.Revision++
	if _, err = tx.ExecContext(ctx, `UPDATE plans SET status='running',error=NULL,revision=$2,stages=$3 WHERE id=$1`, id, plan.Revision, jsonText(plan.Stages)); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO plan_stage_continuations(source_run_id,run_id,plan_id,stage_id,request_plan_revision,request,result) VALUES($1,$2,$3,$4,$5,$6,$7)`, request.SourceRunID, run.ID, id, stageID, request.PlanRevision, jsonText(request), jsonText(plan)); err != nil {
		return nil, err
	}
	return plan, tx.Commit()
}
