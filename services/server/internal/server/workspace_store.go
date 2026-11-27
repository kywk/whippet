package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

func jsonText(value any) string { data, _ := json.Marshal(value); return string(data) }

const workspaceCoreColumns = `w.id,COALESCE(w.management_name,w.name),w.settings,w.lifecycle,w.canonical_config,w.authorization_revision,w.scope_status,
 (SELECT c.id FROM conversations c WHERE c.workspace_id=w.id AND c.owner_type='workspace'),
 (SELECT r.id FROM runs r WHERE r.workspace_id=w.id AND r.test_id IS NULL AND r.kind='author' AND r.status IN ('queued','dispatched','running','collecting','cancelling')),w.current_proposal_id,w.author_engine,w.login_state,` + workspaceManagementColumns

func readWorkspaceCore(ctx context.Context, q queryDB, id string, lock bool) (Workspace, *string, error) {
	stmt := `SELECT ` + workspaceCoreColumns + ` FROM workspaces w WHERE w.id=$1`
	if lock {
		stmt += " FOR UPDATE OF w"
	}
	return scanWorkspaceCore(q.QueryRowContext(ctx, stmt, id))
}

func lockWorkspaceSettings(ctx context.Context, tx *sql.Tx, id string) (Workspace, *string, error) {
	if err := authorizeWorkspace(ctx, id); err != nil {
		return Workspace{}, nil, err
	}
	actor := actorFromContext(ctx)
	if actor.user.ID == "" {
		return readWorkspaceCore(ctx, tx, id, true)
	}
	// Match membership writes: lock the directory role before the Workspace.
	role, err := lockActorSiteRole(ctx, tx, actor)
	if err != nil {
		return Workspace{}, nil, err
	}
	w, proposalID, err := readWorkspaceCore(ctx, tx, id, true)
	if err != nil || role.admin() {
		return w, proposalID, err
	}
	member, err := readMemberRole(ctx, tx, id, actor.user.ID)
	if err != nil {
		return w, proposalID, err
	}
	permissions := permissionsForWorkspace(role, member)
	if !permissions.ManageTests {
		return w, proposalID, ErrNotFound
	}
	if !permissions.ManageSettings {
		return w, proposalID, errForbidden
	}
	return w, proposalID, nil
}

func scanWorkspaceCore(row scanner, extra ...any) (Workspace, *string, error) {
	var w Workspace
	var legacy, config, loginState []byte
	var proposalID *string
	fields := []any{&w.ID, &w.Name, &legacy, &w.Lifecycle, &config, &w.AuthorizationRevision, &w.ScopeStatus, &w.ConversationID, &w.ActiveRunID, &proposalID, &w.AuthorEngine, &loginState}
	fields = append(fields, w.Management.scanFields()...)
	if err := row.Scan(append(fields, extra...)...); err != nil {
		return w, nil, dbError(err)
	}
	w.Management.setUTC()
	s, err := decodeSettings(legacy)
	if err != nil {
		return w, nil, err
	}
	w.WorkspaceSettings = *s
	if len(config) > 0 && json.Unmarshal(config, &w.Settings) != nil {
		return w, nil, fmt.Errorf("invalid saved Workspace configuration")
	}
	if err := json.Unmarshal(loginState, &w.loginState); err != nil {
		return w, nil, fmt.Errorf("invalid saved Workspace login state")
	}
	setSavedWorkspaceTestDefaults(w.Settings)
	w.SiteReadiness = workspaceSiteReadiness(w.Settings, confirmedCanonical(w))
	w.Roles = []RoleRef{}
	w.ExecutionAvailable = true
	return w, proposalID, nil
}

const workspaceProposalColumns = `id,workspace_id,conversation_id,source_run_id,base_revision,context_revision,status,content,scope_hash,scope_confirmed,invalidation_reason,applied_revision,created_at,login_state`

func readProposal(ctx context.Context, q queryDB, workspaceID, id string, lock bool) (WorkspaceProposal, error) {
	stmt := `SELECT ` + workspaceProposalColumns + ` FROM workspace_proposals WHERE id=$1 AND workspace_id=$2`
	if lock {
		stmt += " FOR UPDATE"
	}
	p, err := scanWorkspaceProposal(q.QueryRowContext(ctx, stmt, id, workspaceID))
	if err != nil {
		return p, err
	}
	err = populateProposalLogin(ctx, q, &p)
	return p, err
}

func scanWorkspaceProposal(row scanner) (WorkspaceProposal, error) {
	var p WorkspaceProposal
	var raw, loginState []byte
	if err := row.Scan(&p.ID, &p.WorkspaceID, &p.ConversationID, &p.SourceRunID, &p.BaseRevision, &p.ContextRevision, &p.Status, &raw, &p.ScopeHash, &p.ScopeConfirmed, &p.InvalidationReason, &p.AppliedRevision, &p.CreatedAt, &loginState); err != nil {
		return p, dbError(err)
	}
	if json.Unmarshal(raw, &p.Content) != nil || json.Unmarshal(loginState, &p.loginState) != nil {
		return p, fmt.Errorf("invalid saved Workspace proposal")
	}
	setSavedWorkspaceTestDefaults(&p.Content)
	p.CreatedAt = p.CreatedAt.UTC()
	return p, nil
}

func populateProposalLogin(ctx context.Context, q queryDB, p *WorkspaceProposal) error {
	var err error
	p.SiteReadiness, p.AccountCredentials, _, err = projectWorkspaceLogin(ctx, q, p.WorkspaceID, &p.Content, p.loginState, p.ScopeConfirmed)
	return err
}

func populateWorkspaceLogin(ctx context.Context, q queryDB, w *Workspace) error {
	var err error
	w.SiteReadiness, _, w.accountBindings, err = projectWorkspaceLogin(ctx, q, w.ID, w.Settings, w.loginState, confirmedCanonical(*w))
	return err
}

func fillWorkspace(ctx context.Context, q queryDB, w Workspace, proposalID *string, secrets bool, tls ...bool) (Workspace, error) {
	if err := populateWorkspaceLogin(ctx, q, &w); err != nil {
		return w, err
	}
	w.SecretsAvailable = secrets
	if proposalID != nil {
		p, err := readProposal(ctx, q, w.ID, *proposalID, false)
		if err != nil {
			return w, err
		}
		w.CurrentProposal = &p
	}
	ids := workspaceRoleIDs(w)
	rows, err := q.QueryContext(ctx, `SELECT `+workspaceRoleColumns+` FROM workspace_roles WHERE workspace_id=$1 ORDER BY id`, w.ID)
	if err != nil {
		return w, err
	}
	defer rows.Close()
	for rows.Next() {
		ref, err := scanWorkspaceRole(rows)
		if err != nil {
			return w, err
		}
		if ids[ref.RoleID] {
			w.Roles = append(w.Roles, ref)
		}
	}
	if err := rows.Err(); err != nil {
		return w, err
	}
	setWorkspaceAvailability(&w, secrets, len(tls) > 0 && tls[0])
	return w, nil
}

func workspaceRoleIDs(w Workspace) map[string]bool {
	ids := map[string]bool{}
	if w.Settings != nil {
		for _, role := range w.Settings.LoginRoles {
			if role.RoleID != nil {
				ids[*role.RoleID] = true
			}
		}
	}
	if w.CurrentProposal != nil {
		for _, role := range w.CurrentProposal.Content.LoginRoles {
			if role.RoleID != nil {
				ids[*role.RoleID] = true
			}
		}
	}
	return ids
}

const workspaceRoleColumns = `id,secret_ref,secret_version,configured`

func scanWorkspaceRole(row scanner, extra ...any) (RoleRef, error) {
	var ref RoleRef
	fields := []any{&ref.RoleID, &ref.SecretRef, &ref.SecretVersion, &ref.Configured}
	err := row.Scan(append(fields, extra...)...)
	return ref, err
}

func setWorkspaceAvailability(w *Workspace, secrets, tls bool) {
	w.SecretsAvailable = secrets
	if reason := workspaceErrorCode(w.Management.State.workError()); reason != "" {
		unavailable := capability(false, reason)
		w.Capabilities = WorkspaceCapabilities{AIExploration: unavailable, AIExecution: unavailable, ManualExecution: unavailable, CredentialLogin: unavailable}
		w.ExecutionAvailable = false
		w.UnavailableReason = &reason
		return
	}
	w.Capabilities = workspaceCapabilities(*w, secrets, tls)
	w.ExecutionAvailable = w.Capabilities.AIExecution.Available || w.Capabilities.ManualExecution.Available
	if !w.ExecutionAvailable {
		w.UnavailableReason = stringPointer("security_unavailable")
	}
}

func workspaceContext(w Workspace) *WorkspaceContext {
	scope := &WorkspaceContext{WorkspaceID: w.ID, SettingsRevision: w.Revision, Config: workspaceScopeConfig(w.Settings), RoleRefs: w.Roles}
	setAccountSnapshot(scope, w.Settings, w.accountBindings)
	return scope
}

func decodeWorkspaceContext(raw []byte) (*WorkspaceContext, error) {
	var c *WorkspaceContext
	if len(raw) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("invalid saved Workspace context")
	}
	return c, nil
}
func sameWorkspaceContext(a, b *WorkspaceContext) bool { return jsonText(a) == jsonText(b) }
func contextForTest(ctx context.Context, q queryDB, testID string) (*WorkspaceContext, error) {
	var id string
	if err := q.QueryRowContext(ctx, `SELECT workspace_id FROM tests WHERE id=$1`, testID).Scan(&id); err != nil {
		return nil, dbError(err)
	}
	w, pid, err := readWorkspaceCore(ctx, q, id, false)
	if err != nil {
		return nil, err
	}
	w, err = fillWorkspace(ctx, q, w, pid, false)
	if err != nil {
		return nil, err
	}
	return workspaceContext(w), nil
}

func (p *Postgres) CreateWorkspace(ctx context.Context, name string) (Workspace, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "未命名工作區"
	}
	if !configName(name) {
		return Workspace{}, configError()
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback()
	if actor := actorFromContext(ctx); actor.user.ID != "" {
		if err := requireSiteManager(ctx, tx, actor); err != nil {
			return Workspace{}, err
		}
	}
	id, conversationID := NewID(), NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO workspaces(id,name,lifecycle) VALUES($1,$2,'draft')`, id, name); err != nil {
		return Workspace{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO workspace_memberships(workspace_id,user_id,role)
VALUES($1,$2,$3),($1,$4,$5)`, id, developmentWorkspaceAdmin, workspaceAdmin, developmentQA, workspaceQA); err != nil {
		return Workspace{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO conversations(id,workspace_id,owner_type) VALUES($1,$2,'workspace')`, conversationID, id); err != nil {
		return Workspace{}, err
	}
	w, proposal, err := readWorkspaceCore(ctx, tx, id, false)
	if err != nil {
		return w, err
	}
	w, err = fillWorkspace(ctx, tx, w, proposal, p.Secrets != nil, p.CredentialTLS)
	if err != nil {
		return w, err
	}
	if err = tx.Commit(); err != nil {
		return w, err
	}
	return w, nil
}

func (p *Postgres) WorkspaceProposal(ctx context.Context, workspaceID, id string) (WorkspaceProposal, error) {
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return WorkspaceProposal{}, err
	}
	defer tx.Rollback()
	proposal, err := readProposal(ctx, tx, workspaceID, id, false)
	if err != nil {
		return proposal, err
	}
	return proposal, tx.Commit()
}

func roleEligible(w Workspace, id string) bool {
	if w.Settings != nil {
		for _, r := range w.Settings.LoginRoles {
			if stringValue(r.RoleID) == id {
				return true
			}
		}
	}
	if w.CurrentProposal != nil && (w.CurrentProposal.Status == "pending" || confirmedProposal(w)) {
		for _, r := range w.CurrentProposal.Content.LoginRoles {
			if stringValue(r.RoleID) == id {
				return true
			}
		}
	}
	return false
}
func lockCredentialRole(ctx context.Context, tx *sql.Tx, workspaceID, roleID string, expected int, secrets bool) (Workspace, RoleRef, error) {
	w, pid, err := lockWorkspaceSettings(ctx, tx, workspaceID)
	if err != nil {
		return w, RoleRef{}, err
	}
	w, err = fillWorkspace(ctx, tx, w, pid, secrets)
	if err != nil {
		return w, RoleRef{}, err
	}
	if !roleEligible(w, roleID) {
		return w, RoleRef{}, ErrNotFound
	}
	var r RoleRef
	err = tx.QueryRowContext(ctx, `SELECT id,secret_ref,secret_version,configured FROM workspace_roles WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, roleID, workspaceID).Scan(&r.RoleID, &r.SecretRef, &r.SecretVersion, &r.Configured)
	if err != nil {
		return w, r, dbError(err)
	}
	current := 0
	if r.SecretVersion != nil {
		current = *r.SecretVersion
	}
	if current != expected {
		return w, r, ErrConflict
	}
	return w, r, nil
}
func (p *Postgres) SaveWorkspaceCredentials(ctx context.Context, workspaceID, roleID string, expected int, values credentialValues) (RoleRef, error) {
	if p.Secrets == nil {
		return RoleRef{}, ErrSecretsUnavailable
	}
	if expected < 0 || !validOutputText(values.Username, 4096) || !validOutputText(values.Password, 4096) {
		return RoleRef{}, fmt.Errorf("%w: invalid credential fields", ErrInvalid)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return RoleRef{}, err
	}
	defer tx.Rollback()
	w, ref, err := lockCredentialRole(ctx, tx, workspaceID, roleID, expected, true)
	if err != nil {
		return ref, err
	}
	if err := w.Management.State.workError(); err != nil {
		return ref, err
	}
	workspaceID, roleID = w.ID, ref.RoleID
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_secrets SET revoked_at=COALESCE(revoked_at,now()) WHERE role_id=$1 AND workspace_id=$2`, roleID, workspaceID); err != nil {
		return ref, err
	}
	secretRef, version, err := p.sealAccountSecret(ctx, tx, workspaceID, roleID, values)
	if err != nil {
		return ref, err
	}
	ref.SecretRef = &secretRef
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_roles SET secret_ref=$3,secret_version=$4,configured=true WHERE id=$1 AND workspace_id=$2`, roleID, workspaceID, *ref.SecretRef, version); err != nil {
		return ref, err
	}
	if err = bumpWorkspaceAuthorization(ctx, tx, workspaceID); err != nil {
		return ref, err
	}
	if err = cancelRoleRuns(ctx, tx, workspaceID, roleID); err != nil {
		return ref, err
	}
	if err = cancelAccountConsumers(ctx, tx, workspaceID, roleID, "", true); err != nil {
		return ref, err
	}
	if err = refreshWorkspaceDrafts(ctx, tx, workspaceID, true); err != nil {
		return ref, err
	}
	ref.SecretVersion = &version
	ref.Configured = true
	if err = tx.Commit(); err != nil {
		return ref, err
	}
	return ref, nil
}
func (p *Postgres) RevokeWorkspaceCredentials(ctx context.Context, workspaceID, roleID string, expected int) (RoleRef, error) {
	if p.Secrets == nil {
		return RoleRef{}, ErrSecretsUnavailable
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return RoleRef{}, err
	}
	defer tx.Rollback()
	_, ref, err := lockCredentialRole(ctx, tx, workspaceID, roleID, expected, true)
	if err != nil {
		return ref, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_secrets SET revoked_at=COALESCE(revoked_at,now()) WHERE role_id=$1 AND workspace_id=$2`, roleID, workspaceID); err != nil {
		return ref, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_roles SET configured=false WHERE id=$1 AND workspace_id=$2`, roleID, workspaceID); err != nil {
		return ref, err
	}
	if ref.Configured {
		if err = cancelRoleRuns(ctx, tx, workspaceID, roleID); err != nil {
			return ref, err
		}
		if err = cancelAccountConsumers(ctx, tx, workspaceID, roleID, "", true); err != nil {
			return ref, err
		}
		if err = refreshWorkspaceDrafts(ctx, tx, workspaceID, true); err != nil {
			return ref, err
		}
		if err = bumpWorkspaceAuthorization(ctx, tx, workspaceID); err != nil {
			return ref, err
		}
	}
	ref.Configured = false
	if err = tx.Commit(); err != nil {
		return ref, err
	}
	return ref, nil
}
func bumpWorkspaceAuthorization(ctx context.Context, tx *sql.Tx, id string) error {
	_, err := tx.ExecContext(ctx, `UPDATE workspaces SET authorization_revision=authorization_revision+1 WHERE id=$1`, id)
	return err
}
