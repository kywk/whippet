package server

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"time"
)

type BrowserSessionItem struct {
	SessionID  string    `json:"sessionId"`
	LeaseID    string    `json:"leaseId"`
	State      string    `json:"state"`
	CreatedAt  time.Time `json:"createdAt"`
	DeadlineAt time.Time `json:"deadlineAt"`
}

type BrowserSessionTarget struct {
	SessionID, LeaseID, WorkspaceID, ManagerID, ManagerEpoch string
}

// Only current, authorized leases can be discovered or watched. The caller
// also checks the current in-memory Manager connection and its epoch.
const browserSessionAuthority = `l.reclaimed=false AND l.deadline_at>now()
 AND t.revoked_at IS NULL AND w.authorization_revision=l.authorization_revision
 AND ((l.author_run_id IS NULL AND w.lifecycle='active' AND w.scope_status='confirmed' AND l.workspace_context->'config'=w.canonical_config)
 OR (l.author_run_id IS NOT NULL AND w.scope_status<>'revoking' AND EXISTS(
 SELECT 1 FROM external_author_claims c JOIN runs r ON r.id=c.run_id AND r.attempt_id=c.attempt_id AND r.workspace_id=c.workspace_id
 WHERE c.run_id=l.author_run_id AND c.browser_session_id=l.session_id AND c.token_id=l.token_id AND c.workspace_id=l.workspace_id
 AND c.state='active' AND c.expires_at>now() AND c.deadline_at>now() AND r.author_intent_checked AND r.status='running' AND r.author_engine='external'
 AND r.workspace_context=l.workspace_context)))`

func (p *Postgres) BrowserSessions(ctx context.Context, workspace, managerID, epoch string) ([]BrowserSessionItem, error) {
	if !ValidID(workspace) || !ValidID(epoch) || managerID == "" {
		return nil, ErrInvalid
	}
	var exists bool
	if err := p.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)`, workspace).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT l.session_id,l.lease_id,l.state,l.created_at,l.deadline_at
 FROM agent_browser_leases l JOIN agent_tokens t ON t.id=l.token_id AND t.workspace_id=l.workspace_id
 JOIN workspaces w ON w.id=l.workspace_id
 WHERE l.workspace_id=$1 AND l.manager_id=$2 AND l.manager_epoch=$3
 AND l.state IN ('opening','ready') AND `+browserSessionAuthority+`
 ORDER BY l.created_at DESC,l.session_id DESC LIMIT 100`, workspace, managerID, epoch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []BrowserSessionItem{}
	for rows.Next() {
		var item BrowserSessionItem
		if err := rows.Scan(&item.SessionID, &item.LeaseID, &item.State, &item.CreatedAt, &item.DeadlineAt); err != nil {
			return nil, err
		}
		item.CreatedAt, item.DeadlineAt = item.CreatedAt.UTC(), item.DeadlineAt.UTC()
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) BrowserSessionLiveTarget(ctx context.Context, sessionID, leaseID string) (BrowserSessionTarget, error) {
	var target BrowserSessionTarget
	if !ValidID(sessionID) || !ValidID(leaseID) {
		return target, ErrInvalid
	}
	err := p.DB.QueryRowContext(ctx, `SELECT l.session_id,l.lease_id,l.workspace_id,l.manager_id,l.manager_epoch
 FROM agent_browser_leases l JOIN agent_tokens t ON t.id=l.token_id AND t.workspace_id=l.workspace_id
 JOIN workspaces w ON w.id=l.workspace_id
 WHERE l.session_id=$1 AND l.lease_id=$2 AND l.state='ready' AND `+browserSessionAuthority, sessionID, leaseID).
		Scan(&target.SessionID, &target.LeaseID, &target.WorkspaceID, &target.ManagerID, &target.ManagerEpoch)
	return target, dbError(err)
}

type BrowserSessionCredentials struct {
	SessionID   string `json:"sessionId"`
	LeaseID     string `json:"leaseId"`
	WorkspaceID string `json:"workspaceId"`
	RoleID      string `json:"roleId"`
	LoginOrigin string `json:"loginOrigin"`
	Username    string `json:"username"`
	Password    string `json:"password"`
}

func (p *Postgres) lockBrowserCredentialLease(ctx context.Context, tx *sql.Tx, managerID, epoch, sessionID, leaseID string) (Workspace, BrowserLease, *WorkspaceContext, error) {
	var tokenID, workspaceID string
	if err := tx.QueryRowContext(ctx, `SELECT token_id,workspace_id FROM agent_browser_leases WHERE session_id=$1 AND lease_id=$2`, sessionID, leaseID).Scan(&tokenID, &workspaceID); err != nil {
		return Workspace{}, BrowserLease{}, nil, dbError(err)
	}
	w, proposalID, err := readWorkspaceCore(ctx, tx, workspaceID, true)
	if err != nil {
		return w, BrowserLease{}, nil, err
	}
	var tokenWorkspace string
	var revoked sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT workspace_id,revoked_at FROM agent_tokens WHERE id=$1 FOR UPDATE`, tokenID).Scan(&tokenWorkspace, &revoked); err != nil || revoked.Valid || tokenWorkspace != workspaceID {
		return w, BrowserLease{}, nil, ErrCredentialUnavailable
	}
	w, err = fillWorkspace(ctx, tx, w, proposalID, true, p.CredentialTLS)
	if err != nil {
		return w, BrowserLease{}, nil, err
	}
	lease, err := scanBrowserLease(tx.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+`
 FROM agent_browser_leases WHERE session_id=$1 AND lease_id=$2 AND token_id=$3 AND workspace_id=$4 FOR UPDATE`, sessionID, leaseID, tokenID, workspaceID))
	if err != nil {
		return w, lease, nil, err
	}
	if lease.State != "ready" || lease.Reclaimed || !lease.DeadlineAt.After(time.Now()) || lease.ManagerID != managerID || lease.ManagerEpoch != epoch {
		return w, lease, nil, ErrCredentialUnavailable
	}
	snapshot, err := browserLeaseScope(ctx, tx, w, lease)
	if err != nil {
		return w, lease, nil, ErrCredentialUnavailable
	}
	return w, lease, snapshot, nil
}

func (p *Postgres) ResolveBrowserSessionCredentials(ctx context.Context, managerID, epoch, sessionID, leaseID, roleID string) (BrowserSessionCredentials, error) {
	var result BrowserSessionCredentials
	if p.Secrets == nil {
		return result, ErrSecretsUnavailable
	}
	if !ValidID(sessionID) || !ValidID(leaseID) || !ValidID(roleID) || !ValidID(epoch) || managerID == "" {
		return result, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	w, lease, snapshot, err := p.lockBrowserCredentialLease(ctx, tx, managerID, epoch, sessionID, leaseID)
	if err != nil {
		return result, err
	}
	workspaceID := lease.WorkspaceID
	var request CredentialRequest
	request.RoleID = roleID
	for _, ref := range snapshot.RoleRefs {
		if ref.RoleID == roleID && ref.Configured && ref.SecretRef != nil && ref.SecretVersion != nil {
			request.SecretRef, request.SecretVersion = *ref.SecretRef, *ref.SecretVersion
			break
		}
	}
	if request.SecretRef == "" || request.SecretVersion < 1 {
		return result, ErrCredentialUnavailable
	}
	role, err := taskRole(snapshot, request)
	if err != nil || !confirmedLogin(w, roleID, role.LoginOrigin) {
		return result, ErrCredentialUnavailable
	}
	var configured bool
	var ref sql.NullString
	var version sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT configured,secret_ref,secret_version FROM workspace_roles WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, roleID, workspaceID).
		Scan(&configured, &ref, &version); err != nil {
		return result, dbError(err)
	}
	if !configured || !ref.Valid || ref.String != request.SecretRef || !version.Valid || version.Int64 != int64(request.SecretVersion) {
		return result, ErrCredentialUnavailable
	}
	var nonce, sealed []byte
	err = tx.QueryRowContext(ctx, `SELECT nonce,ciphertext FROM workspace_secrets WHERE workspace_id=$1 AND role_id=$2 AND secret_ref=$3 AND secret_version=$4 AND revoked_at IS NULL`, workspaceID, roleID, request.SecretRef, request.SecretVersion).Scan(&nonce, &sealed)
	if errors.Is(err, sql.ErrNoRows) {
		return result, ErrCredentialUnavailable
	}
	if err != nil {
		return result, err
	}
	values, err := p.Secrets.open(workspaceID, roleID, request.SecretRef, request.SecretVersion, nonce, sealed)
	if err != nil || !validOutputText(values.Username, 4096) || !validOutputText(values.Password, 4096) {
		return result, ErrSecretsUnavailable
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return BrowserSessionCredentials{sessionID, leaseID, workspaceID, roleID, role.LoginOrigin, values.Username, values.Password}, nil
}

type BrowserSessionAccountCredentials struct {
	SessionID    string `json:"sessionId"`
	LeaseID      string `json:"leaseId"`
	WorkspaceID  string `json:"workspaceId"`
	CallID       string `json:"callId"`
	AccountID    string `json:"accountId"`
	TargetOrigin string `json:"targetOrigin"`
	LoginOrigin  string `json:"loginOrigin"`
	Username     string `json:"username"`
	Password     string `json:"password"`
}

func (p *Postgres) resolveBrowserSessionAccountCredentials(ctx context.Context, manager, epoch, sessionID, leaseID, callID, accountID, target string) (BrowserSessionAccountCredentials, error) {
	var result BrowserSessionAccountCredentials
	if p.Secrets == nil {
		return result, ErrSecretsUnavailable
	}
	if !p.readyForWorkspaceLogin() {
		return result, ErrCredentialUnavailable
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	w, lease, snapshot, err := p.lockBrowserCredentialLease(ctx, tx, manager, epoch, sessionID, leaseID)
	if err != nil {
		return result, err
	}
	binding := snapshotAccountBinding(snapshot, w.ID, accountID, target)
	if binding == nil || !lease.accountToolPinned() {
		return result, ErrCredentialUnavailable
	}
	var prior []byte
	var callState string
	if err := tx.QueryRowContext(ctx, `SELECT request_hash,state FROM agent_browser_calls WHERE session_id=$1 AND call_id=$2 FOR UPDATE`,
		sessionID, callID).Scan(&prior, &callState); err != nil {
		return result, dbError(err)
	}
	expected := browserCallHash(browserLoginAccountTool, accountToolPayload(accountID, target))
	if callState != "sent" || !bytes.Equal(prior, expected[:]) {
		return result, ErrCredentialUnavailable
	}
	if err := formalAccountBindingAllowed(ctx, tx, w, *binding); err != nil {
		return result, err
	}
	values, err := p.openAccountSecret(ctx, tx, w.ID, *binding)
	if err != nil {
		return result, err
	}
	origin, err := workspaceURLOrigin(binding.EntryURL)
	if err != nil {
		return result, ErrCredentialUnavailable
	}
	if lease.AuthorRunID != nil {
		var attemptID string
		if err := tx.QueryRowContext(ctx, `SELECT attempt_id FROM runs WHERE id=$1 AND workspace_id=$2 AND status='running' FOR UPDATE`,
			*lease.AuthorRunID, w.ID).Scan(&attemptID); err != nil {
			return result, dbError(err)
		}
		if err := recordResolvedAccount(ctx, tx, *lease.AuthorRunID, attemptID, *binding); err != nil {
			return result, err
		}
	}
	result = BrowserSessionAccountCredentials{sessionID, leaseID, w.ID, callID, accountID, target, origin, values.Username, values.Password}
	return result, tx.Commit()
}
