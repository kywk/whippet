package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
)

type StageRetryRequest struct {
	PlanRevision          int    `json:"planRevision"`
	ModuleRevision        int    `json:"moduleRevision"`
	ModuleContextRevision int64  `json:"moduleContextRevision"`
	Confirmed             bool   `json:"confirmed"`
	Content               string `json:"content"`
}
type StageRetrySource struct {
	ModuleTestID          string  `json:"moduleTestId"`
	EditingSessionID      string  `json:"editingSessionId"`
	ModuleRevision        int     `json:"moduleRevision"`
	ModuleContextRevision int64   `json:"moduleContextRevision"`
	AuthorRunID           string  `json:"authorRunId"`
	AuthorStatus          string  `json:"authorStatus"`
	ValidationRunID       *string `json:"validationRunId"`
	ValidationStatus      *string `json:"validationStatus"`
	Reclaimed             bool    `json:"reclaimed"`
}
type StageRetry struct {
	Eligible     bool              `json:"eligible"`
	Reason       *string           `json:"reason"`
	PlanRevision int               `json:"planRevision"`
	Source       *StageRetrySource `json:"source"`
}

func retryReason(r StageRetry, reason string) StageRetry { r.Reason = &reason; return r }
func retryFailure(status string) bool                    { return status == "failed" || status == "timed_out" }
func retryCancelled(status string) bool {
	return status == "cancelled" || status == "cancelling" || status == "interrupted"
}

// Pure SELECTs only. In POST the caller first locks the Workspace, Tests and Plan.
func (p *Postgres) inspectStageRetry(ctx context.Context, tx *sql.Tx, plan *Plan, stageID string) (StageRetry, error) {
	r := StageRetry{PlanRevision: plan.Revision}
	index := -1
	for i, s := range plan.Stages {
		if s.ID == stageID {
			index = i
		}
	}
	if index < 0 {
		return r, ErrNotFound
	}
	stage := plan.Stages[index]
	var workspace string
	if err := tx.QueryRowContext(ctx, `SELECT t.workspace_id FROM tests t JOIN editing_sessions e ON e.test_id=t.id WHERE t.id=$1 AND e.id=$2 AND t.kind='usecase'`, plan.TestID, plan.EditingSessionID).Scan(&workspace); err != nil {
		return r, dbError(err)
	}
	if err := authorizeWorkspace(ctx, workspace); err != nil {
		return r, err
	}
	if plan.Status != "stopped" {
		return retryReason(r, "plan_not_stopped"), nil
	}
	var cancelled bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM plan_operations WHERE plan_id=$1 AND operation='cancel' AND request_revision >= COALESCE((SELECT MAX(request_revision) FROM plan_operations WHERE plan_id=$1 AND operation='confirm'),0))`, plan.ID).Scan(&cancelled); err != nil {
		return r, err
	}
	if cancelled || stringValue(plan.Error) == "cancelled" {
		return retryReason(r, "cancelled"), nil
	}
	if stage.Status != "failed" || (stage.Action != "create" && stage.Action != "modify") {
		return retryReason(r, "stage_not_retryable"), nil
	}
	for _, s := range plan.Stages[index+1:] {
		if s.Status != "pending" {
			return retryReason(r, "stage_not_retryable"), nil
		}
	}
	if stage.AuthorRunID == nil || stage.ModuleTestID == "" {
		return retryReason(r, "source_unavailable"), nil
	}
	var raw []byte
	var source StageRetrySource
	var released bool
	var cancelRequested sql.NullBool
	var authorRevision int
	var runWorkspace, kind string
	err := tx.QueryRowContext(ctx, `SELECT r.test_id,r.editing_session_id,r.status,r.slot_released,r.author_payload,r.draft_revision,r.workspace_id,t.kind,r.cancel_requested FROM runs r JOIN tests t ON t.id=r.test_id WHERE r.id=$1`, *stage.AuthorRunID).Scan(&source.ModuleTestID, &source.EditingSessionID, &source.AuthorStatus, &released, &raw, &authorRevision, &runWorkspace, &kind, &cancelRequested)
	if errors.Is(err, sql.ErrNoRows) {
		return retryReason(r, "source_unavailable"), nil
	}
	if err != nil {
		return r, err
	}
	var input AuthorInput
	if json.Unmarshal(raw, &input) != nil || input.SkillID != "module-authoring" || input.Platform == nil || stringValue(input.Platform.PlanID) != plan.ID || stringValue(input.Platform.StageID) != stage.ID || input.EditingSessionID != source.EditingSessionID || source.ModuleTestID != stage.ModuleTestID || runWorkspace != workspace || kind != "module" || input.BaseRevision != authorRevision {
		return retryReason(r, "source_unavailable"), nil
	}
	if cancelRequested.Valid && cancelRequested.Bool {
		return retryReason(r, "cancelled"), nil
	}
	if !cancelRequested.Valid {
		return retryReason(r, "source_unavailable"), nil
	}
	source.AuthorRunID = *stage.AuthorRunID
	source.ModuleRevision = input.BaseRevision
	source.ModuleContextRevision = input.ContextRevision
	if retryCancelled(source.AuthorStatus) {
		return retryReason(r, "cancelled"), nil
	}
	var candidateHash string
	if source.AuthorStatus == "succeeded" {
		if stage.CandidateVersionID == nil || stage.ValidationRunID == nil {
			return retryReason(r, "source_unavailable"), nil
		}
		var vr string
		var validationReleased bool
		err = tx.QueryRowContext(ctx, `SELECT c.revision,c.context_revision,c.bundle_hash,r.status,r.slot_released,r.cancel_requested FROM plan_module_candidates c JOIN module_validation_requests q ON q.source_run_id=c.source_run_id JOIN runs r ON r.id=q.validation_run_id WHERE c.id=$1 AND c.plan_id=$2 AND c.stage_id=$3 AND c.source_run_id=$4 AND c.test_id=$5 AND c.editing_session_id=$6 AND r.id=$7 AND r.test_id=c.test_id AND r.editing_session_id=c.editing_session_id AND r.draft_revision=c.revision AND q.revision=c.revision AND q.context_revision=c.context_revision AND q.resolved`, *stage.CandidateVersionID, plan.ID, stage.ID, source.AuthorRunID, source.ModuleTestID, source.EditingSessionID, *stage.ValidationRunID).Scan(&source.ModuleRevision, &source.ModuleContextRevision, &candidateHash, &vr, &validationReleased, &cancelRequested)
		if errors.Is(err, sql.ErrNoRows) {
			return retryReason(r, "source_unavailable"), nil
		}
		if err != nil {
			return r, err
		}
		if cancelRequested.Valid && cancelRequested.Bool {
			return retryReason(r, "cancelled"), nil
		}
		if !cancelRequested.Valid {
			return retryReason(r, "source_unavailable"), nil
		}
		source.ValidationRunID = stage.ValidationRunID
		source.ValidationStatus = &vr
		released = released && validationReleased
		if retryCancelled(vr) {
			return retryReason(r, "cancelled"), nil
		}
		if !retryFailure(vr) {
			return retryReason(r, "stage_not_retryable"), nil
		}
	} else if !retryFailure(source.AuthorStatus) {
		return retryReason(r, "stage_not_retryable"), nil
	}
	r.Source = &source
	ms, err := readEditing(ctx, tx, source.ModuleTestID, source.EditingSessionID)
	if errors.Is(err, ErrNotFound) || (err == nil && (ms.Status != "active" || ms.WorkspaceID != workspace)) {
		return retryReason(r, "session_closed"), nil
	}
	if err != nil {
		return r, err
	}
	us, err := readEditing(ctx, tx, plan.TestID, plan.EditingSessionID)
	if err != nil {
		return r, err
	}
	if us.Status != "active" {
		return retryReason(r, "session_closed"), nil
	}
	var pending bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE editing_session_id IN ($1,$2) AND (status NOT IN ('succeeded','failed','timed_out','cancelled','interrupted') OR NOT slot_released))`, ms.ID, us.ID).Scan(&pending); err != nil {
		return r, err
	}
	source.Reclaimed = released && !pending
	if !source.Reclaimed {
		return retryReason(r, "reclaim_pending"), nil
	}
	md, err := scanDraft(tx.QueryRowContext(ctx, draftSelect, source.ModuleTestID))
	if errors.Is(err, ErrNotFound) {
		return retryReason(r, "snapshot_mismatch"), nil
	}
	if err != nil {
		return r, err
	}
	ud, err := scanDraft(tx.QueryRowContext(ctx, draftSelect, plan.TestID))
	if errors.Is(err, ErrNotFound) {
		return retryReason(r, "snapshot_mismatch"), nil
	}
	if err != nil {
		return r, err
	}
	if md.EditingSessionID != ms.ID || md.Revision != source.ModuleRevision || ms.ContextRevision != source.ModuleContextRevision || ud.EditingSessionID != us.ID || ud.Revision != plan.BaseRevision || us.ContextRevision != plan.ContextRevision {
		return retryReason(r, "snapshot_mismatch"), nil
	}
	if candidateHash != "" {
		snap, e := moduleSummarySnapshot(md)
		if e != nil || snap.BundleHash != candidateHash || md.ValidationRunID == nil || *md.ValidationRunID != *source.ValidationRunID {
			return retryReason(r, "snapshot_mismatch"), nil
		}
	}
	for _, prior := range plan.Stages[:index] {
		if prior.Status != "ready" || p.retryPriorStage(ctx, tx, plan, prior, workspace) != nil {
			return retryReason(r, "prior_stage_invalid"), nil
		}
	}
	probe := editingAuthorInput(ms, md, "module-authoring", nil)
	if _, _, err = p.prepareAuthor(ctx, tx, md, &probe); err != nil {
		if errors.Is(err, ErrScopeConfirmation) || errors.Is(err, ErrConflict) {
			return retryReason(r, "scope_unavailable"), nil
		}
		return r, err
	}
	r.Eligible = true
	return r, nil
}

func (p *Postgres) retryPriorStage(ctx context.Context, tx *sql.Tx, plan *Plan, stage PlanStage, workspace string) error {
	if stage.Action == "reuse" {
		_, err := resolveModuleDependencies(ctx, tx, workspace, []Stage{{ID: stage.ID, Title: stage.Title, Kind: "module", ModuleTestID: stage.ModuleTestID, ModuleVersionID: stage.ModuleVersionID, Args: map[string]StageArgument{}}})
		return err
	}
	if stage.CandidateVersionID == nil || stage.ValidationRunID == nil || stage.AuthorRunID == nil {
		return ErrConflict
	}
	var sid, hash string
	var rev int
	var cr int64
	if err := tx.QueryRowContext(ctx, `SELECT c.editing_session_id,c.revision,c.context_revision,c.bundle_hash FROM plan_module_candidates c JOIN tests t ON t.id=c.test_id WHERE c.id=$1 AND c.plan_id=$2 AND c.stage_id=$3 AND c.test_id=$4 AND c.source_run_id=$5 AND t.workspace_id=$6`, *stage.CandidateVersionID, plan.ID, stage.ID, stage.ModuleTestID, *stage.AuthorRunID, workspace).Scan(&sid, &rev, &cr, &hash); err != nil {
		return err
	}
	s, err := readEditing(ctx, tx, stage.ModuleTestID, sid)
	if err != nil {
		return err
	}
	d, err := scanDraft(tx.QueryRowContext(ctx, draftSelect, stage.ModuleTestID))
	if err != nil {
		return err
	}
	if s.Status != "active" || s.ContextRevision != cr || d.EditingSessionID != sid || d.Revision != rev || d.ValidationRunID == nil || *d.ValidationRunID != *stage.ValidationRunID || !runReclaimed(ctx, tx, *stage.AuthorRunID) || !runReclaimed(ctx, tx, *stage.ValidationRunID) {
		return ErrConflict
	}
	snap, err := moduleSummarySnapshot(d)
	if err != nil || snap.BundleHash != hash {
		return ErrConflict
	}
	proof, err := p.readValidationProof(ctx, tx, d, false)
	if err != nil {
		return err
	}
	return checkPublication(rev, true, d, proof)
}

func (p *Postgres) StageRetry(ctx context.Context, id, stage string) (StageRetry, error) {
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return StageRetry{}, err
	}
	defer tx.Rollback()
	plan, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1`, id))
	if err != nil {
		return StageRetry{}, err
	}
	r, err := p.inspectStageRetry(ctx, tx, plan, stage)
	if err != nil {
		return r, err
	}
	return r, tx.Commit()
}

func (p *Postgres) RetryPlanStage(ctx context.Context, id, stageID string, request StageRetryRequest) (*Plan, error) {
	if request.PlanRevision < 1 || request.ModuleRevision < 1 || request.ModuleContextRevision < 0 || !request.Confirmed || validateUserMessage(request.Content) != nil {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Lock the Use Case first, as all existing Plan operations do. Module locks are
	// stable ordered; no Module completion acquires a Plan row lock in reverse.
	plan, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1`, id))
	if err != nil {
		return nil, err
	}
	var workspace string
	if err = tx.QueryRowContext(ctx, `SELECT t.workspace_id FROM tests t JOIN editing_sessions e ON e.test_id=t.id WHERE t.id=$1 AND e.id=$2 AND t.kind='usecase'`, plan.TestID, plan.EditingSessionID).Scan(&workspace); err != nil {
		return nil, dbError(err)
	}
	if err = authorizeWorkspace(ctx, workspace); err != nil {
		return nil, err
	}
	if _, err = lockEditingTest(ctx, tx, plan.TestID); err != nil {
		return nil, err
	}
	plan, err = scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return nil, err
	}
	var oldStage string
	var oldRequest, result []byte
	err = tx.QueryRowContext(ctx, `SELECT stage_id,request,result FROM plan_stage_retries WHERE plan_id=$1 AND request_plan_revision=$2`, id, request.PlanRevision).Scan(&oldStage, &oldRequest, &result)
	if err == nil {
		var prior StageRetryRequest
		if json.Unmarshal(oldRequest, &prior) != nil || prior != request || oldStage != stageID {
			return nil, ErrConflict
		}
		var saved Plan
		if json.Unmarshal(result, &saved) != nil {
			return nil, ErrConflict
		}
		return &saved, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	exists := false
	for _, s := range plan.Stages {
		if s.ID == stageID {
			exists = true
		}
	}
	if !exists {
		return nil, ErrNotFound
	}
	if plan.Revision != request.PlanRevision {
		return nil, ErrConflict
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, s := range plan.Stages {
		if s.ModuleTestID != "" && !seen[s.ModuleTestID] {
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
	eligibility, err := p.inspectStageRetry(ctx, tx, plan, stageID)
	if err != nil {
		return nil, err
	}
	source := eligibility.Source
	if !eligibility.Eligible || source == nil || source.ModuleRevision != request.ModuleRevision || source.ModuleContextRevision != request.ModuleContextRevision {
		return nil, ErrConflict
	}
	d, s, err := requireEditingDraft(ctx, tx, source.ModuleTestID, source.EditingSessionID)
	if err != nil {
		return nil, err
	}
	var stage *PlanStage
	for i := range plan.Stages {
		if plan.Stages[i].ID == stageID {
			stage = &plan.Stages[i]
		}
	}
	run, err := p.enqueuePlanModuleAuthor(ctx, tx, plan, stage, d, s, request.Content)
	if err != nil {
		return nil, err
	}
	stage.Status = "authoring"
	stage.AuthorRunID = &run.ID
	stage.ValidationRunID = nil
	stage.CandidateVersionID = nil
	stage.DraftRevision = &d.Revision
	stage.Error = nil
	plan.Status = "running"
	plan.Revision++
	plan.Error = nil
	if _, err = tx.ExecContext(ctx, `UPDATE plans SET status='running',revision=$2,error=NULL,stages=$3 WHERE id=$1`, id, plan.Revision, jsonText(plan.Stages)); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO plan_stage_retries(plan_id,request_plan_revision,stage_id,request,source_author_run_id,source_validation_run_id,new_author_run_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, request.PlanRevision, stageID, jsonText(request), source.AuthorRunID, source.ValidationRunID, run.ID, jsonText(plan)); err != nil {
		return nil, err
	}
	return plan, tx.Commit()
}
