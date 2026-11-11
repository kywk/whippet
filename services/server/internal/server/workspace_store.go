package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

func jsonText(value any) string { data, _ := json.Marshal(value); return string(data) }

func readWorkspaceCore(ctx context.Context, q queryDB, id string, lock bool) (Workspace, *string, error) {
	var w Workspace
	var legacy, config []byte
	var proposalID *string
	stmt := `SELECT w.id,w.name,w.settings,w.lifecycle,w.canonical_config,w.authorization_revision,w.scope_status,
 (SELECT c.id FROM conversations c WHERE c.workspace_id=w.id AND c.owner_type='workspace'),
 (SELECT r.id FROM runs r WHERE r.workspace_id=w.id AND r.test_id IS NULL AND r.kind='author' AND r.status IN ('queued','dispatched','running','collecting','cancelling')),w.current_proposal_id
 FROM workspaces w WHERE w.id=$1`
	if lock {
		stmt += " FOR UPDATE OF w"
	}
	err := q.QueryRowContext(ctx, stmt, id).Scan(&w.ID, &w.Name, &legacy, &w.Lifecycle, &config, &w.AuthorizationRevision, &w.ScopeStatus, &w.ConversationID, &w.ActiveRunID, &proposalID)
	if err != nil {
		return w, nil, dbError(err)
	}
	s, err := decodeSettings(legacy)
	if err != nil {
		return w, nil, err
	}
	w.WorkspaceSettings = *s
	if len(config) > 0 && json.Unmarshal(config, &w.Settings) != nil {
		return w, nil, fmt.Errorf("invalid saved Workspace configuration")
	}
	w.Roles = []RoleRef{}
	w.ExecutionAvailable = true
	return w, proposalID, nil
}

func readProposal(ctx context.Context, q queryDB, workspaceID, id string, lock bool) (WorkspaceProposal, error) {
	var p WorkspaceProposal
	var raw []byte
	stmt := `SELECT id,workspace_id,conversation_id,source_run_id,base_revision,context_revision,status,content,scope_hash,scope_confirmed,invalidation_reason,applied_revision,created_at
 FROM workspace_proposals WHERE id=$1 AND workspace_id=$2`
	if lock {
		stmt += " FOR UPDATE"
	}
	err := q.QueryRowContext(ctx, stmt, id, workspaceID).Scan(&p.ID, &p.WorkspaceID, &p.ConversationID, &p.SourceRunID, &p.BaseRevision, &p.ContextRevision, &p.Status, &raw, &p.ScopeHash, &p.ScopeConfirmed, &p.InvalidationReason, &p.AppliedRevision, &p.CreatedAt)
	if err != nil {
		return p, dbError(err)
	}
	if json.Unmarshal(raw, &p.Content) != nil {
		return p, fmt.Errorf("invalid saved Workspace proposal")
	}
	p.CreatedAt = p.CreatedAt.UTC()
	return p, nil
}

func fillWorkspace(ctx context.Context, q queryDB, w Workspace, proposalID *string, secrets bool, tls ...bool) (Workspace, error) {
	w.SecretsAvailable = secrets
	if proposalID != nil {
		p, err := readProposal(ctx, q, w.ID, *proposalID, false)
		if err != nil {
			return w, err
		}
		w.CurrentProposal = &p
	}
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
	rows, err := q.QueryContext(ctx, `SELECT id,secret_ref,secret_version,configured FROM workspace_roles WHERE workspace_id=$1 ORDER BY id`, w.ID)
	if err != nil {
		return w, err
	}
	defer rows.Close()
	for rows.Next() {
		var ref RoleRef
		if err := rows.Scan(&ref.RoleID, &ref.SecretRef, &ref.SecretVersion, &ref.Configured); err != nil {
			return w, err
		}
		if ids[ref.RoleID] {
			w.Roles = append(w.Roles, ref)
		}
	}
	if err := rows.Err(); err != nil {
		return w, err
	}
	w.Capabilities = workspaceCapabilities(w, secrets, len(tls) > 0 && tls[0])
	w.ExecutionAvailable = w.Capabilities.AIExecution.Available || w.Capabilities.ManualExecution.Available
	if !w.ExecutionAvailable {
		w.UnavailableReason = stringPointer("security_unavailable")
	}
	return w, nil
}

func workspaceContext(w Workspace) *WorkspaceContext {
	return &WorkspaceContext{SchemaVersion: "1", WorkspaceID: w.ID, SettingsRevision: w.Revision, Config: w.Settings, RoleRefs: w.Roles}
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
	id, conversationID := NewID(), NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO workspaces(id,name,lifecycle) VALUES($1,$2,'draft')`, id, name); err != nil {
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
	return readProposal(ctx, p.DB, workspaceID, id, false)
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
	w, pid, err := readWorkspaceCore(ctx, tx, workspaceID, true)
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
	_, ref, err := lockCredentialRole(ctx, tx, workspaceID, roleID, expected, true)
	if err != nil {
		return ref, err
	}
	if ref.SecretRef == nil {
		ref.SecretRef = stringPointer(NewID())
	}
	version := expected + 1
	nonce, sealed, err := p.Secrets.seal(workspaceID, roleID, *ref.SecretRef, version, values)
	if err != nil {
		return ref, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_secrets SET revoked_at=COALESCE(revoked_at,now()) WHERE role_id=$1 AND workspace_id=$2`, roleID, workspaceID); err != nil {
		return ref, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO workspace_secrets(workspace_id,role_id,secret_ref,secret_version,nonce,ciphertext) VALUES($1,$2,$3,$4,$5,$6)`, workspaceID, roleID, *ref.SecretRef, version, nonce, sealed); err != nil {
		return ref, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_roles SET secret_ref=$3,secret_version=$4,configured=true WHERE id=$1 AND workspace_id=$2`, roleID, workspaceID, *ref.SecretRef, version); err != nil {
		return ref, err
	}
	if err = bumpWorkspaceAuthorization(ctx, tx, workspaceID); err != nil {
		return ref, err
	}
	if err = cancelRoleRuns(ctx, tx, workspaceID, roleID); err != nil {
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
