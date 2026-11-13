package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

var ErrScopeConfirmation = errors.New("scope_confirmation_required")
var ErrCredentialUnavailable = errors.New("credential_unavailable")

func effectiveScriptOrigin(origin string) string {
	if origin == "" {
		return "legacy"
	}
	return origin
}

type Capability struct {
	Available bool    `json:"available"`
	Reason    *string `json:"reason"`
}
type WorkspaceCapabilities struct {
	AIExploration   Capability `json:"aiExploration"`
	AIExecution     Capability `json:"aiExecution"`
	ManualExecution Capability `json:"manualExecution"`
	CredentialLogin Capability `json:"credentialLogin"`
}

func capability(available bool, reason string) Capability {
	if available {
		return Capability{Available: true}
	}
	return Capability{Reason: stringPointer(reason)}
}
func confirmedCanonical(w Workspace) bool {
	return w.Lifecycle == "active" && w.ScopeStatus != "revoking" && w.Settings != nil && len(w.Settings.Targets) > 0
}
func confirmedProposal(w Workspace) bool {
	p := w.CurrentProposal
	return w.ScopeStatus != "revoking" && p != nil && p.ScopeConfirmed && p.BaseRevision == w.Revision && len(p.Content.Targets) > 0 &&
		(p.Status == "pending" || p.Status == "applied" || (p.Status == "stale" && stringValue(p.InvalidationReason) == "context_changed"))
}
func configRole(c *WorkspaceConfig, id string) *WorkspaceRole {
	if c != nil {
		for i := range c.LoginRoles {
			if stringValue(c.LoginRoles[i].RoleID) == id {
				return &c.LoginRoles[i]
			}
		}
	}
	return nil
}
func loginOriginAllowed(c *WorkspaceConfig, origin string) bool {
	if c == nil {
		return false
	}
	for _, x := range c.ExcludedOrigins {
		if x == origin {
			return false
		}
	}
	for _, x := range c.Targets {
		if x.Origin == origin {
			return true
		}
	}
	for _, x := range c.Dependencies {
		if x.Purpose == "login" && x.Origin == origin {
			return true
		}
	}
	return false
}
func confirmedLogin(w Workspace, role string, origin string) bool {
	configs := []*WorkspaceConfig{}
	if confirmedCanonical(w) {
		configs = append(configs, w.Settings)
	}
	if confirmedProposal(w) {
		configs = append(configs, &w.CurrentProposal.Content)
	}
	for _, c := range configs {
		r := configRole(c, role)
		if r != nil && r.LoginMethod == "form" && r.LoginOrigin == origin && loginOriginAllowed(c, origin) {
			return true
		}
	}
	return false
}
func selectedContext(w Workspace, proposalFirst bool) (*WorkspaceContext, *string) {
	c := workspaceContext(w)
	var proposal *string
	if proposalFirst && confirmedProposal(w) {
		c.Config = &w.CurrentProposal.Content
		proposal = stringPointer(w.CurrentProposal.ID)
	} else if !confirmedCanonical(w) {
		c.Config = nil
	}
	c.RoleRefs = []RoleRef{}
	for _, ref := range w.Roles {
		if configRole(c.Config, ref.RoleID) != nil {
			c.RoleRefs = append(c.RoleRefs, ref)
		}
	}
	return c, proposal
}
func workspaceCapabilities(w Workspace, secrets, tls bool) WorkspaceCapabilities {
	exploration := confirmedCanonical(w) || confirmedProposal(w)
	c := WorkspaceCapabilities{AIExploration: capability(exploration, "scope_confirmation_required"), AIExecution: capability(confirmedCanonical(w), "scope_confirmation_required"), ManualExecution: capability(true, "")}
	reason := "credentials_required"
	switch {
	case !tls:
		reason = "protected_transport_required"
	case !secrets:
		reason = "secrets_unavailable"
	case !exploration:
		reason = "scope_confirmation_required"
	default:
		for _, r := range w.Roles {
			if r.Configured {
				for _, config := range []*WorkspaceConfig{w.Settings, proposalConfig(w)} {
					role := configRole(config, r.RoleID)
					if role != nil && confirmedLogin(w, r.RoleID, role.LoginOrigin) {
						c.CredentialLogin = capability(true, "")
						return c
					}
				}
			}
		}
	}
	c.CredentialLogin = capability(false, reason)
	return c
}
func proposalConfig(w Workspace) *WorkspaceConfig {
	if w.CurrentProposal != nil {
		return &w.CurrentProposal.Content
	}
	return nil
}

// A browser workflow policy, not an arbitrary Node network sandbox. Required
// origins/purposes cannot grow by silently substituting a broader current config.
func scopeWithin(required, approved *WorkspaceConfig) bool {
	if required == nil || approved == nil || len(required.Targets) == 0 {
		return false
	}
	targets := map[string]bool{}
	deps := map[string]string{}
	excluded := map[string]bool{}
	for _, t := range approved.Targets {
		targets[t.Origin] = true
	}
	for _, d := range approved.Dependencies {
		deps[d.Origin] = d.Purpose
	}
	for _, x := range approved.ExcludedOrigins {
		excluded[x] = true
	}
	for _, t := range required.Targets {
		if !targets[t.Origin] || excluded[t.Origin] {
			return false
		}
	}
	for _, d := range required.Dependencies {
		if deps[d.Origin] != d.Purpose || excluded[d.Origin] {
			return false
		}
	}
	for _, r := range required.LoginRoles {
		current := configRole(approved, stringValue(r.RoleID))
		if current == nil || current.LoginOrigin != r.LoginOrigin {
			return false
		}
	}
	return true
}
func scopeBinding(w Workspace, snapshot *WorkspaceContext, proposal *string) (*int64, *string, error) {
	if snapshot == nil || snapshot.WorkspaceID != w.ID {
		return nil, nil, ErrScopeConfirmation
	}
	if proposal != nil {
		if confirmedProposal(w) && w.CurrentProposal.ID == *proposal && scopeWithin(snapshot.Config, &w.CurrentProposal.Content) {
			rev := w.AuthorizationRevision
			return &rev, proposal, nil
		}
	} else if confirmedCanonical(w) && scopeWithin(snapshot.Config, w.Settings) {
		rev := w.AuthorizationRevision
		return &rev, nil, nil
	}
	return nil, nil, ErrScopeConfirmation
}
func executionBinding(w Workspace, origin string, snapshot *WorkspaceContext) (*int64, *string, error) {
	if origin == "manual" {
		return nil, nil, nil
	}
	if effectiveScriptOrigin(origin) != "ai" && effectiveScriptOrigin(origin) != "legacy" {
		return nil, nil, ErrInvalid
	}
	return scopeBinding(w, snapshot, nil)
}
func workspaceForTest(ctx context.Context, q queryDB, testID string) (Workspace, error) {
	var id string
	if err := q.QueryRowContext(ctx, `SELECT workspace_id FROM tests WHERE id=$1`, testID).Scan(&id); err != nil {
		return Workspace{}, dbError(err)
	}
	w, pid, err := readWorkspaceCore(ctx, q, id, false)
	if err != nil {
		return w, err
	}
	return fillWorkspace(ctx, q, w, pid, false)
}
func executionForDraft(ctx context.Context, q queryDB, d draftState) (*int64, *string, error) {
	w, err := workspaceForTest(ctx, q, d.TestID)
	if err != nil {
		return nil, nil, err
	}
	return executionBinding(w, d.ScriptOrigin, d.WorkspaceContext)
}

var browserTools = []string{"browser_navigate", "browser_snapshot", "browser_click", "browser_fill"}

func hasBrowserTools(input *AuthorInput) bool {
	if input != nil {
		for _, t := range input.AllowedTools {
			for _, b := range browserTools {
				if t == b {
					return true
				}
			}
			if t == "browser_login" || t == "update_module_candidate" || t == "commit_module_candidate" {
				return true
			}
		}
	}
	return false
}
func (p *Postgres) prepareAuthor(ctx context.Context, q queryDB, d draftState, input *AuthorInput) (*int64, *string, error) {
	if input.SkillID == "acceptance-summary" || input.SkillID == "usecase-planner" {
		return nil, nil, nil
	}
	w, err := workspaceForTest(ctx, q, d.TestID)
	if err != nil {
		return nil, nil, err
	}
	rev, pid, scopeErr := scopeBinding(w, d.WorkspaceContext, nil)
	if input.SkillID == "module-authoring" && scopeErr != nil {
		return nil, nil, ErrScopeConfirmation
	}
	if scopeErr == nil {
		input.AllowedTools = append(input.AllowedTools, browserTools...)
		if p.CredentialTLS && p.Secrets != nil {
			input.AllowedTools = append(input.AllowedTools, "browser_login")
		}
	}
	if _, _, err := executionBinding(w, d.ScriptOrigin, d.WorkspaceContext); err == nil {
		input.AllowedTools = append(input.AllowedTools, "request_validation")
	}
	if scopeErr != nil {
		return nil, nil, nil
	}
	return rev, pid, nil
}
func (p *Postgres) assignmentAllowed(ctx context.Context, q queryDB, a Assignment) error {
	if a.Kind == "author" && !hasBrowserTools(a.Author) {
		return nil
	}
	if a.Kind != "author" && a.ScriptOrigin == "manual" {
		return nil
	}
	w, pid, err := readWorkspaceCore(ctx, q, a.WorkspaceID, false)
	if err != nil {
		return err
	}
	w, err = fillWorkspace(ctx, q, w, pid, p.Secrets != nil, p.CredentialTLS)
	if err != nil {
		return err
	}
	if a.Kind == "author" {
		_, _, err = scopeBinding(w, a.WorkspaceContext, a.scopeProposalID)
	} else {
		_, _, err = executionBinding(w, a.ScriptOrigin, a.WorkspaceContext)
	}
	return err
}

// Unacknowledged network/AI work already being cancelled must not be started
// solely to explain cancellation; Manager can persist an unknown cancel result.
func (p *Postgres) CanDispatch(a Assignment) bool {
	return (a.Kind != "author" && a.ScriptOrigin == "manual") || (a.Kind == "author" && !hasBrowserTools(a.Author))
}
func offlineAuthorAllowed(a Assignment) bool {
	if a.Kind != "author" || a.Author == nil || hasBrowserTools(a.Author) {
		return false
	}
	for _, tool := range a.Author.AllowedTools {
		if tool != "read_draft" && tool != "read_validation_report" && tool != "update_draft" && tool != "read_conversation_history" && tool != "read_skill_reference" && !platformServerTool(tool) {
			return false
		}
	}
	return true
}

// Kept as the common tick seam; B validates actual assignments at claim/replay.
func (p *Postgres) rejectUnsafeWork(context.Context) error { return nil }
func loadRunRoles(ctx context.Context, q queryDB, id string) error {
	var valid bool
	err := q.QueryRowContext(ctx, `SELECT NOT EXISTS(SELECT 1 FROM runs r CROSS JOIN LATERAL unnest(r.resolved_role_ids) AS resolved(role_id)
 LEFT JOIN workspace_roles role ON role.id=role_id AND role.workspace_id=r.workspace_id
 WHERE r.id=$1 AND (NOT COALESCE(role.configured,false) OR NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(r.workspace_context->'roleRefs') ref WHERE ref->>'roleId'=role.id::text AND ref->>'secretRef'=role.secret_ref::text AND (ref->>'secretVersion')::integer=role.secret_version)))`, id).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrCredentialUnavailable
	}
	var rolesJSON, raw []byte
	var workspace string
	if err = q.QueryRowContext(ctx, `SELECT to_json(resolved_role_ids),workspace_context,workspace_id FROM runs WHERE id=$1`, id).Scan(&rolesJSON, &raw, &workspace); err != nil {
		return err
	}
	var roles []string
	if json.Unmarshal(rolesJSON, &roles) != nil {
		return ErrCredentialUnavailable
	}
	if len(roles) == 0 {
		return nil
	}
	snapshot, err := decodeWorkspaceContext(raw)
	if err != nil {
		return err
	}
	w, pid, err := readWorkspaceCore(ctx, q, workspace, false)
	if err != nil {
		return err
	}
	w, err = fillWorkspace(ctx, q, w, pid, false)
	if err != nil {
		return err
	}
	for _, roleID := range roles {
		var config *WorkspaceConfig
		if snapshot != nil {
			config = snapshot.Config
		}
		role := configRole(config, roleID)
		if role == nil || !confirmedLogin(w, roleID, role.LoginOrigin) {
			return ErrCredentialUnavailable
		}
	}
	return nil
}
func cancelRoleRuns(ctx context.Context, tx *sql.Tx, workspace, role string) error {
	_, err := tx.ExecContext(ctx, `UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,
 finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,error='credential_unavailable'
 WHERE workspace_id=$1 AND $2::uuid=ANY(resolved_role_ids) AND status IN ('queued','dispatched','running','collecting')`, workspace, role)
	return err
}

func workspaceAuthorToolsValid(tools []string) bool {
	for _, tool := range tools {
		found := tool == "browser_login" || tool == "read_conversation_history"
		for _, allowed := range browserTools {
			found = found || tool == allowed
		}
		if !found {
			return false
		}
	}
	return true
}
func workspaceRunScopeValid(ctx context.Context, q queryDB, w Workspace, id string) bool {
	var raw []byte
	var proposal *string
	if q.QueryRowContext(ctx, `SELECT workspace_context,scope_proposal_id FROM runs WHERE id=$1`, id).Scan(&raw, &proposal) != nil {
		return false
	}
	snapshot, err := decodeWorkspaceContext(raw)
	if err != nil {
		return false
	}
	_, _, err = scopeBinding(w, snapshot, proposal)
	return err == nil
}
func cancelAIRuns(ctx context.Context, tx *sql.Tx, workspace, except string) error {
	_, err := tx.ExecContext(ctx, `UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,
 finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,error='scope_confirmation_required'
 WHERE workspace_id=$1 AND id::text<>$2 AND status IN ('queued','dispatched','running','collecting') AND
 ((kind IN ('run','validation') AND script_origin<>'manual') OR (kind='author' AND
 author_payload->'allowedTools' ?| ARRAY['browser_navigate','browser_snapshot','browser_click','browser_fill','browser_login']))`, workspace, except)
	return err
}
