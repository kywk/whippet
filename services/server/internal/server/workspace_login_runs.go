package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type loginPrecondition string

func (e loginPrecondition) Error() string { return string(e) }

type workspaceLoginRequest struct {
	BaseRevision int    `json:"baseRevision"`
	RequestID    string `json:"requestId"`
	AccountID    string `json:"accountId"`
	TargetOrigin string `json:"targetOrigin"`
}

func (p *Postgres) readyForWorkspaceLogin() bool {
	return p.WorkspaceLoginEnabled && p.CredentialTLS && p.Secrets != nil
}

func (p *Postgres) queueWorkspaceLogin(ctx context.Context, workspace, proposalID string, request workspaceLoginRequest) (Run, error) {
	target, err := normalizedOrigin(request.TargetOrigin)
	if err != nil || !ValidID(request.RequestID) || !ValidID(request.AccountID) || request.BaseRevision < 1 {
		return Run{}, ErrInvalid
	}
	accountID := strings.ToLower(request.AccountID)
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	w, current, err := lockWorkspaceSettings(ctx, tx, workspace)
	if err != nil {
		return Run{}, err
	}
	workspace = w.ID
	var existingID string
	var existing []byte
	err = tx.QueryRowContext(ctx, `SELECT id,login_verification FROM runs WHERE workspace_id=$1 AND scope_proposal_id=$2 AND login_request_id=$3`,
		workspace, proposalID, request.RequestID).Scan(&existingID, &existing)
	if err == nil {
		var prior LoginVerification
		if json.Unmarshal(existing, &prior) != nil || prior.BaseRevision != request.BaseRevision || prior.Binding.AccountID != accountID || prior.Binding.TargetOrigin != target {
			return Run{}, ErrConflict
		}
		return scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, existingID))
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Run{}, err
	}
	proposal, err := readProposal(ctx, tx, workspace, proposalID, true)
	if err != nil {
		return Run{}, err
	}
	if err := pendingWorkspaceProposal(ctx, tx, w, current, proposal, request.BaseRevision); err != nil {
		return Run{}, err
	}
	site, scope := accountSite(&proposal.Content, accountID, target)
	if site == nil {
		return Run{}, ErrNotFound
	}
	if !testsAuthenticated(scope) {
		if scope == testScopeUnknown {
			return Run{}, loginPrecondition("scope_choice_required")
		}
		return Run{}, ErrConflict
	}
	if !proposal.ScopeConfirmed || w.ScopeStatus == "revoking" {
		return Run{}, ErrScopeConfirmation
	}
	if !completeLoginForm(*site) {
		return Run{}, loginPrecondition(pendingSiteAccountReason(*site, true))
	}
	if p.Secrets == nil {
		return Run{}, ErrSecretsUnavailable
	}
	if !p.readyForWorkspaceLogin() {
		return Run{}, ErrSecurityUnavailable
	}
	var draft *proposalCredential
	if saved, ok := proposal.loginState.Credentials[accountID]; ok {
		draft = &saved
	}
	ref, err := effectiveProposalCredential(ctx, tx, workspace, accountID, draft)
	if err != nil {
		return Run{}, err
	}
	state := proposal.loginState.Sites[accountID][target]
	if state.Version == "" {
		state = loginSiteState{Version: NewID()}
	}
	binding, ok := currentLoginBinding(accountID, *site, state, ref)
	if !ok {
		return Run{}, loginPrecondition("credentials_required")
	}
	if state.RunID != nil {
		var active bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT FROM runs WHERE id=$1 AND status IN ('queued','dispatched','running','collecting','cancelling'))`, state.RunID).Scan(&active); err != nil {
			return Run{}, err
		}
		if active {
			return Run{}, ErrConflict
		}
	}
	actor := actorFromContext(ctx)
	if actor.user.ID == "" {
		return Run{}, errForbidden
	}
	login := LoginVerification{proposal.ID, proposal.BaseRevision, proposal.ContextRevision, proposal.ScopeHash, binding}
	workspaceScope := WorkspaceContext{SchemaVersion: "1", WorkspaceID: workspace, SettingsRevision: w.Revision,
		Config: workspaceScopeConfig(&proposal.Content), RoleRefs: []RoleRef{}}
	id := NewID()
	_, err = tx.ExecContext(ctx, `INSERT INTO runs(id,workspace_id,test_id,kind,script_snapshot,script_hash,script_origin,timeout_ms,
 workspace_settings,workspace_context,authorization_revision,scope_proposal_id,login_verification,login_request_id,login_requested_by,login_requested_bootstrap)
 VALUES($1,$2,NULL,$3,'',$4,'legacy',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		id, workspace, workspaceLoginVerificationKind, scriptHash(""), proposal.Content.TimeoutMS,
		settingsJSON(&w.WorkspaceSettings), jsonText(workspaceScope), w.AuthorizationRevision, proposal.ID, jsonText(login), request.RequestID, actor.user.ID, actor.bootstrap)
	if err != nil {
		return Run{}, err
	}
	if proposal.loginState.Sites == nil {
		proposal.loginState.Sites = make(map[string]map[string]loginSiteState)
	}
	if proposal.loginState.Sites[accountID] == nil {
		proposal.loginState.Sites[accountID] = make(map[string]loginSiteState)
	}
	state.RunID, state.Proof = &id, nil
	proposal.loginState.Sites[accountID][target] = state
	if err := saveProposalLoginState(ctx, tx, proposal); err != nil {
		return Run{}, err
	}
	run, err := scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, id))
	if err != nil {
		return run, err
	}
	return run, tx.Commit()
}

func loginRequesterAllowed(ctx context.Context, q queryDB, workspace string, actor platformActor) error {
	if actor.bootstrap {
		return nil
	}
	var role siteRole
	if err := q.QueryRowContext(ctx, `SELECT site_role FROM platform_users WHERE id=$1`, actor.user.ID).Scan(&role); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errForbidden
		}
		return err
	}
	if role.admin() {
		return nil
	}
	member, err := readMemberRole(ctx, q, workspace, actor.user.ID)
	if err != nil {
		return err
	}
	if !permissionsForWorkspace(role, member).ManageSettings {
		return errForbidden
	}
	return nil
}

func activeWorkspaceLogin(ctx context.Context, q queryDB, w Workspace, currentID *string, runID string, login *LoginVerification, actor platformActor) (WorkspaceProposal, error) {
	if login == nil || currentID == nil || *currentID != login.ProposalID || w.ScopeStatus == "revoking" {
		return WorkspaceProposal{}, ErrScopeConfirmation
	}
	if err := loginRequesterAllowed(ctx, q, w.ID, actor); err != nil {
		return WorkspaceProposal{}, err
	}
	proposal, err := readProposal(ctx, q, w.ID, *currentID, false)
	if err != nil {
		return proposal, err
	}
	if err := pendingWorkspaceProposal(ctx, q, w, currentID, proposal, login.BaseRevision); err != nil {
		return proposal, err
	}
	if !proposal.ScopeConfirmed || proposal.ScopeHash != login.ScopeHash || proposal.ContextRevision != login.ContextRevision {
		return proposal, ErrScopeConfirmation
	}
	account, target := login.Binding.AccountID, login.Binding.TargetOrigin
	site, scope := accountSite(&proposal.Content, account, target)
	state := proposal.loginState.Sites[account][target]
	if site == nil || !testsAuthenticated(scope) || stringValue(state.RunID) != runID {
		return proposal, ErrConflict
	}
	var draft *proposalCredential
	if saved, ok := proposal.loginState.Credentials[account]; ok {
		draft = &saved
	}
	ref, err := effectiveProposalCredential(ctx, q, w.ID, account, draft)
	if err != nil {
		return proposal, err
	}
	binding, ok := currentLoginBinding(account, *site, state, ref)
	if !ok || jsonText(binding) != jsonText(login.Binding) {
		return proposal, ErrCredentialUnavailable
	}
	return proposal, nil
}

type resolvedAccountBinding struct {
	AttemptID          string `json:"attemptId"`
	AccountID          string `json:"accountId"`
	TargetOrigin       string `json:"targetOrigin"`
	LoginConfigVersion string `json:"loginConfigVersion"`
	SecretRef          string `json:"secretRef"`
	SecretVersion      int    `json:"secretVersion"`
}

func resolvedBinding(attempt string, binding LoginBinding) resolvedAccountBinding {
	return resolvedAccountBinding{attempt, binding.AccountID, binding.TargetOrigin, binding.LoginConfigVersion, binding.SecretRef, binding.SecretVersion}
}

func recordResolvedAccount(ctx context.Context, tx *sql.Tx, runID, attemptID string, binding LoginBinding) error {
	receipt := jsonText([]resolvedAccountBinding{resolvedBinding(attemptID, binding)})
	_, err := tx.ExecContext(ctx, `UPDATE runs SET resolved_account_bindings=resolved_account_bindings || $2::jsonb
 WHERE id=$1 AND NOT resolved_account_bindings @> $2::jsonb`, runID, receipt)
	return err
}

func validLoginFailure(reason string) bool {
	switch reason {
	case "login_rejected", "mfa_required", "guest_accessible", "login_not_verified", "credential_unavailable", "invalid_evidence":
		return true
	}
	return false
}

func loginResultDisposition(result Result, target string, resolved bool) (status, reason string) {
	raw := result.LoginVerification
	if result.loginShapeInvalid || result.Error != "" || result.Retest != nil || result.TargetOrigin != "" || result.Assertion != "" ||
		len(raw) > 4096 || len(raw) > 0 && strictJSONNoDuplicates(raw) != nil {
		return "failed", "invalid_evidence"
	}
	switch result.Status {
	case "succeeded":
		if resolved && requiredJSONFields(raw, "observedOrigin", "guest", "submitted", "authenticated") {
			var evidence struct {
				ObservedOrigin string `json:"observedOrigin"`
				Guest          string `json:"guest"`
				Submitted      bool   `json:"submitted"`
				Authenticated  string `json:"authenticated"`
			}
			if json.Unmarshal(raw, &evidence) == nil && evidence.ObservedOrigin == target && evidence.Submitted &&
				evidence.Authenticated == "selector_visible" && (evidence.Guest == "denied" || evidence.Guest == "login_redirect" || evidence.Guest == "selector_hidden") {
				return "succeeded", ""
			}
		}
	case "failed":
		var evidence struct {
			Reason string `json:"reason"`
		}
		if requiredJSONFields(raw, "reason") && json.Unmarshal(raw, &evidence) == nil && validLoginFailure(evidence.Reason) {
			return "failed", evidence.Reason
		}
	case "cancelled", "timed_out":
		if len(raw) == 0 {
			return result.Status, result.Status
		}
	}
	return "failed", "invalid_evidence"
}

type persistedWorkspaceLogin struct {
	Login    *LoginVerification
	Actor    platformActor
	Deadline *time.Time
	Receipt  []byte
	Resolved []resolvedAccountBinding
}

func readPersistedWorkspaceLogin(ctx context.Context, q queryDB, runID string) (persistedWorkspaceLogin, error) {
	var saved persistedWorkspaceLogin
	var spec, resolved []byte
	err := q.QueryRowContext(ctx, `SELECT login_verification,COALESCE(login_requested_by,''),login_requested_bootstrap,
 login_attempt_deadline,login_result_receipt,resolved_account_bindings FROM runs WHERE id=$1 AND kind=$2`, runID, workspaceLoginVerificationKind).
		Scan(&spec, &saved.Actor.user.ID, &saved.Actor.bootstrap, &saved.Deadline, &saved.Receipt, &resolved)
	if err != nil {
		return saved, dbError(err)
	}
	if json.Unmarshal(spec, &saved.Login) != nil || saved.Login == nil || json.Unmarshal(resolved, &saved.Resolved) != nil {
		return saved, ErrInvalid
	}
	return saved, nil
}

func workspaceLoginInactive(err error) bool {
	return errors.Is(err, ErrScopeConfirmation) || errors.Is(err, ErrCredentialUnavailable) || errors.Is(err, ErrConflict) ||
		errors.Is(err, ErrNotFound) || errors.Is(err, errForbidden) || workspaceErrorCode(err) != ""
}

func (p *Postgres) completeWorkspaceLogin(ctx context.Context, workspace, managerID, runID, attemptID string, incoming Result) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	saved, err := readPersistedWorkspaceLogin(ctx, tx, runID)
	if err != nil {
		return err
	}
	if saved.Actor.user.ID != "" {
		if _, err := lockActorSiteRole(ctx, tx, saved.Actor); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
	}
	w, currentID, err := readWorkspaceCore(ctx, tx, workspace, true)
	if err != nil {
		return err
	}
	status, err := lockAttempt(ctx, tx, managerID, runID, attemptID)
	if err != nil {
		return err
	}
	saved, err = readPersistedWorkspaceLogin(ctx, tx, runID)
	if err != nil {
		return err
	}
	var evidence any
	if len(incoming.LoginVerification) > 0 && json.Unmarshal(incoming.LoginVerification, &evidence) != nil {
		evidence = string(incoming.LoginVerification)
	}
	receipt := sha256.Sum256([]byte(jsonText([]any{incoming.Status, len(incoming.LoginVerification) > 0, evidence, incoming.loginShapeInvalid, incoming.Error, incoming.Retest, incoming.TargetOrigin, incoming.Assertion})))
	if Terminal(status) {
		if bytes.Equal(saved.Receipt, receipt[:]) {
			return nil
		}
		return ErrConflict
	}
	resolved := false
	for _, binding := range saved.Resolved {
		resolved = resolved || binding == resolvedBinding(attemptID, saved.Login.Binding)
	}
	final, reason := loginResultDisposition(incoming, saved.Login.Binding.TargetOrigin, resolved)
	proposal, activeErr := activeWorkspaceLogin(ctx, tx, w, currentID, runID, saved.Login, saved.Actor)
	if activeErr != nil && !workspaceLoginInactive(activeErr) {
		return activeErr
	}
	switch {
	case status == "cancelling", activeErr != nil, !p.readyForWorkspaceLogin():
		final, reason = "cancelled", "cancelled"
	case saved.Deadline == nil || final == "succeeded" && !time.Now().Before(*saved.Deadline):
		final, reason = "timed_out", "timed_out"
	case final == "succeeded":
		binding := saved.Login.Binding
		site := proposal.loginState.Sites[binding.AccountID][binding.TargetOrigin]
		site.Proof = &loginProof{binding.SecretRef, binding.SecretVersion, time.Now().UTC()}
		proposal.loginState.Sites[binding.AccountID][binding.TargetOrigin] = site
		if err := saveProposalLoginState(ctx, tx, proposal); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE runs SET status=$2,error=$3,login_result_receipt=$4,finished_at=now(),acknowledged_at=COALESCE(acknowledged_at,now())
 WHERE id=$1`, runID, final, reason, receipt[:])
	if err != nil {
		return err
	}
	return tx.Commit()
}
