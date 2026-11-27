package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

const browserIdleTimeoutMS = 600000
const browserMaxLifetimeMS = 1800000

var browserAllowedTools = []string{"browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_login"}
var errBrowserBusy = errors.New("browser call busy")
var errBrowserScopeInvalid = errors.New("browser scope changed")

type BrowserLease struct {
	SessionID             string              `json:"sessionId"`
	LeaseID               string              `json:"leaseId"`
	State                 string              `json:"state"`
	Reclaimed             bool                `json:"reclaimed"`
	TestAccounts          []AccountDescriptor `json:"testAccounts"`
	TokenID               string              `json:"-"`
	WorkspaceID           string              `json:"-"`
	ManagerID             string              `json:"-"`
	ManagerEpoch          string              `json:"-"`
	RegistryVersion       string              `json:"-"`
	RegistrySHA256        string              `json:"-"`
	WorkspaceContext      json.RawMessage     `json:"-"`
	AuthorizationRevision int64               `json:"-"`
	DeadlineAt            time.Time           `json:"-"`
	AuthorRunID           *string             `json:"-"`
}

const browserLeaseColumns = `session_id,lease_id,state,reclaimed,token_id,workspace_id,manager_id,manager_epoch,registry_version,registry_sha256,workspace_context,authorization_revision,deadline_at,author_run_id`

func scanBrowserLease(row scanner) (BrowserLease, error) {
	var lease BrowserLease
	err := row.Scan(&lease.SessionID, &lease.LeaseID, &lease.State, &lease.Reclaimed, &lease.TokenID,
		&lease.WorkspaceID, &lease.ManagerID, &lease.ManagerEpoch, &lease.RegistryVersion,
		&lease.RegistrySHA256, &lease.WorkspaceContext, &lease.AuthorizationRevision, &lease.DeadlineAt, &lease.AuthorRunID)
	if err != nil {
		return BrowserLease{}, dbError(err)
	}
	return lease, nil
}

func (p *Postgres) BrowserLeaseByRequest(ctx context.Context, tokenID, requestID string) (BrowserLease, error) {
	return scanBrowserLease(p.DB.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases WHERE token_id=$1 AND request_id=$2 AND author_run_id IS NULL`, tokenID, requestID))
}

func (p *Postgres) BrowserLeaseOwned(ctx context.Context, token AgentToken, sessionID, leaseID string) (BrowserLease, error) {
	if !ValidID(sessionID) || !ValidID(leaseID) {
		return BrowserLease{}, ErrInvalid
	}
	return scanBrowserLease(p.DB.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases
		WHERE session_id=$1 AND lease_id=$2 AND token_id=$3 AND workspace_id=$4`, sessionID, leaseID, token.ID, token.WorkspaceID))
}

func (p *Postgres) BrowserLeaseBySession(ctx context.Context, sessionID string) (BrowserLease, error) {
	return scanBrowserLease(p.DB.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases WHERE session_id=$1`, sessionID))
}

func (p *Postgres) OpenBrowserLease(ctx context.Context, token AgentToken, requestID, managerID, epoch string, registry *ToolRegistry, workspace Workspace) (BrowserLease, bool, error) {
	if workspace.ID != token.WorkspaceID || workspace.ScopeStatus != "confirmed" || !confirmedCanonical(workspace) {
		return BrowserLease{}, false, ErrInvalid
	}
	return p.openBrowserLease(ctx, token, requestID, managerID, epoch, registry, &workspace, nil)
}

func (p *Postgres) OpenExternalBrowserLease(ctx context.Context, token AgentToken, claim externalClaim, managerID, epoch string, registry *ToolRegistry) (BrowserLease, bool, error) {
	// The external attempt's known lease ID is not a public browser request ID.
	return p.openBrowserLease(ctx, token, NewID(), managerID, epoch, registry, nil, &claim)
}

func (p *Postgres) openBrowserLease(ctx context.Context, token AgentToken, requestID, managerID, epoch string, registry *ToolRegistry, workspace *Workspace, author *externalClaim) (BrowserLease, bool, error) {
	if !ValidID(requestID) || !ValidID(epoch) {
		return BrowserLease{}, false, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return BrowserLease{}, false, err
	}
	defer tx.Rollback()
	w, err := p.lockBrowserWorkspace(ctx, tx, token.WorkspaceID)
	if err != nil {
		return BrowserLease{}, false, err
	}
	manager, err := readSiteAIManager(ctx, tx, managerID, true)
	if err != nil {
		return BrowserLease{}, false, err
	}
	var tokenWorkspace string
	var revoked sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT workspace_id,revoked_at FROM agent_tokens WHERE id=$1 FOR UPDATE`, token.ID).Scan(&tokenWorkspace, &revoked); err != nil || tokenWorkspace != token.WorkspaceID || revoked.Valid {
		return BrowserLease{}, false, ErrNotFound
	}
	var snapshot *WorkspaceContext
	var authorRunID *string
	deadline := time.Now().Add(30 * time.Minute)
	if author == nil {
		// Public request IDs remain tombstones after cleanup.
		previous, err := scanBrowserLease(tx.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases WHERE token_id=$1 AND request_id=$2 AND author_run_id IS NULL`, token.ID, requestID))
		if err == nil {
			return previous, true, nil
		}
		if !errors.Is(err, ErrNotFound) {
			return BrowserLease{}, false, err
		}
		if w.ScopeStatus != "confirmed" || !confirmedCanonical(w) || w.AuthorizationRevision != workspace.AuthorizationRevision ||
			jsonText(w.Settings) != jsonText(workspace.Settings) {
			return BrowserLease{}, false, ErrConflict
		}
		snapshot = workspaceContext(w)
	} else {
		current, err := p.lockExternalClaim(ctx, tx, token, author.RunID, author.AttemptID, author.LeaseID)
		if err != nil {
			return BrowserLease{}, false, err
		}
		if err = p.externalLive(ctx, tx, current); err != nil {
			return BrowserLease{}, false, err
		}
		snapshot, err = externalBrowserSnapshot(ctx, tx, w, token.ID, current.RunID, current.BrowserSessionID)
		if err != nil {
			return BrowserLease{}, false, err
		}
		if current.BrowserSessionID != nil {
			previous, err := scanBrowserLease(tx.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases WHERE session_id=$1 AND author_run_id=$2 AND token_id=$3 AND workspace_id=$4`, *current.BrowserSessionID, current.RunID, token.ID, token.WorkspaceID))
			return previous, err == nil, err
		}
		authorRunID = &current.RunID
		if current.DeadlineAt.Before(deadline) {
			deadline = current.DeadlineAt
		}
	}
	if err := w.Management.State.workError(); err != nil {
		return BrowserLease{}, false, err
	}
	if !manager.allows(w.ID) {
		return BrowserLease{}, false, ErrConflict
	}
	occupied, err := siteAIManagerOccupancy(ctx, tx, managerID)
	if err != nil {
		return BrowserLease{}, false, err
	}
	conn := p.siteAIConnection()
	if conn.ManagerID != managerID {
		conn = siteAIConnectionView{}
	}
	if conn.available(manager.Capacity, occupied) == 0 {
		return BrowserLease{}, false, ErrConflict
	}
	lease := BrowserLease{SessionID: NewID(), LeaseID: NewID(), State: "opening", TokenID: token.ID,
		WorkspaceID: token.WorkspaceID, ManagerID: managerID, ManagerEpoch: epoch,
		RegistryVersion: registry.Version, RegistrySHA256: registry.SHA256,
		WorkspaceContext: json.RawMessage(jsonText(snapshot)), AuthorizationRevision: w.AuthorizationRevision,
		DeadlineAt: deadline, AuthorRunID: authorRunID}
	_, err = tx.ExecContext(ctx, `INSERT INTO agent_browser_leases(session_id,lease_id,request_id,token_id,workspace_id,manager_id,manager_epoch,
		registry_version,registry_sha256,workspace_context,authorization_revision,state,deadline_at,author_run_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'opening',$12,$13)`, lease.SessionID, lease.LeaseID, requestID,
		lease.TokenID, lease.WorkspaceID, lease.ManagerID, lease.ManagerEpoch, lease.RegistryVersion,
		lease.RegistrySHA256, lease.WorkspaceContext, lease.AuthorizationRevision, lease.DeadlineAt, authorRunID)
	if err != nil {
		return BrowserLease{}, false, dbError(err)
	}
	if authorRunID != nil {
		if _, err := tx.ExecContext(ctx, `UPDATE external_author_claims SET browser_session_id=$2 WHERE run_id=$1`, *authorRunID, lease.SessionID); err != nil {
			return BrowserLease{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return BrowserLease{}, false, err
	}
	return lease, false, nil
}

func (p *Postgres) lockBrowserWorkspace(ctx context.Context, tx *sql.Tx, id string) (Workspace, error) {
	var workspaceID string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR SHARE`, id).Scan(&workspaceID); err != nil {
		return Workspace{}, dbError(err)
	}
	w, proposalID, err := readWorkspaceCore(ctx, tx, workspaceID, false)
	if err != nil {
		return w, err
	}
	return fillWorkspace(ctx, tx, w, proposalID, false)
}

func externalBrowserSnapshot(ctx context.Context, q queryDB, w Workspace, tokenID, runID string, sessionID *string) (*WorkspaceContext, error) {
	var raw []byte
	var proposalID *string
	err := q.QueryRowContext(ctx, `SELECT r.workspace_context,r.scope_proposal_id
 FROM external_author_claims c JOIN runs r ON r.id=c.run_id AND r.attempt_id=c.attempt_id AND r.workspace_id=c.workspace_id
 WHERE c.run_id=$1 AND c.token_id=$2 AND c.workspace_id=$3 AND ($4::uuid IS NULL OR c.browser_session_id=$4)
 AND c.state='active' AND c.expires_at>now() AND c.deadline_at>now()
 AND r.author_intent_checked AND r.status='running' AND r.author_engine='external'`, runID, tokenID, w.ID, sessionID).Scan(&raw, &proposalID)
	if err != nil {
		return nil, errBrowserScopeInvalid
	}
	snapshot, err := decodeWorkspaceContext(raw)
	if err != nil {
		return nil, errBrowserScopeInvalid
	}
	if _, _, err := scopeBinding(w, snapshot, proposalID); err != nil {
		return nil, errBrowserScopeInvalid
	}
	return snapshot, nil
}

func browserLeaseScope(ctx context.Context, q queryDB, w Workspace, lease BrowserLease) (*WorkspaceContext, error) {
	snapshot, err := decodeWorkspaceContext(lease.WorkspaceContext)
	if err != nil || snapshot == nil || snapshot.WorkspaceID != w.ID || lease.AuthorizationRevision != w.AuthorizationRevision {
		return nil, errBrowserScopeInvalid
	}
	if lease.AuthorRunID == nil {
		if w.ScopeStatus != "confirmed" || !confirmedCanonical(w) || jsonText(workspaceScopeConfig(w.Settings)) != jsonText(snapshot.Config) {
			return nil, errBrowserScopeInvalid
		}
		return snapshot, nil
	}
	runSnapshot, err := externalBrowserSnapshot(ctx, q, w, lease.TokenID, *lease.AuthorRunID, &lease.SessionID)
	if err != nil || !sameWorkspaceContext(runSnapshot, snapshot) {
		return nil, errBrowserScopeInvalid
	}
	return snapshot, nil
}

func (p *Postgres) CloseBrowserLease(ctx context.Context, token AgentToken, sessionID, leaseID string) (BrowserLease, error) {
	if !ValidID(sessionID) || !ValidID(leaseID) {
		return BrowserLease{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return BrowserLease{}, err
	}
	defer tx.Rollback()
	if _, err := lockWorkspaceWorkStatus(ctx, tx, token.WorkspaceID); err != nil {
		return BrowserLease{}, err
	}
	if err := lockInteractiveToken(ctx, tx, token); err != nil {
		return BrowserLease{}, err
	}
	lease, err := scanBrowserLease(tx.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases
 WHERE session_id=$1 AND lease_id=$2 AND token_id=$3 AND workspace_id=$4 FOR UPDATE`, sessionID, leaseID, token.ID, token.WorkspaceID))
	if err != nil {
		return BrowserLease{}, err
	}
	if !lease.Reclaimed && lease.State != "closing" {
		if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing' WHERE session_id=$1`, sessionID); err != nil {
			return BrowserLease{}, err
		}
		entry := managementAudit{actorKind: "agent_token", actorID: token.ID, action: "close_browser_lease", target: "browser_lease", targetID: lease.LeaseID, workspace: &lease.WorkspaceID}
		if err := entry.record(ctx, tx, "succeeded", nil); err != nil {
			return BrowserLease{}, err
		}
		lease.State = "closing"
	}
	return lease, tx.Commit()
}

func (p *Postgres) MarkBrowserLeaseReclaimPending(ctx context.Context, managerID string) error {
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_leases SET state='reclaim_pending' WHERE manager_id=$1 AND NOT reclaimed`, managerID)
	if err != nil {
		return err
	}
	_, err = p.DB.ExecContext(ctx, `UPDATE agent_browser_calls SET state='unknown' WHERE state='sent' AND session_id IN
		(SELECT session_id FROM agent_browser_leases WHERE manager_id=$1 AND NOT reclaimed)`, managerID)
	return err
}

// A Server process cannot recover in-memory call results or prove Docker
// cleanup. Persist that uncertainty before accepting new MCP requests.
func (p *Postgres) RecoverBrowserLeases(ctx context.Context) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='reclaim_pending' WHERE NOT reclaimed`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_calls SET state='unknown' WHERE state='sent'`); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *Postgres) ExpireBrowserLeases(ctx context.Context) error {
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing'
		WHERE NOT reclaimed AND state IN ('opening','ready') AND deadline_at<=now()`)
	return err
}

func (p *Postgres) BrowserLeasesToClose(ctx context.Context, managerID string) ([]BrowserLease, error) {
	rows, err := p.DB.QueryContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases
		WHERE manager_id=$1 AND NOT reclaimed AND state IN ('closing','reclaim_pending')
		AND (close_sent_at IS NULL OR close_sent_at < now()-interval '5 seconds') ORDER BY created_at`, managerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var leases []BrowserLease
	for rows.Next() {
		lease, err := scanBrowserLease(rows)
		if err != nil {
			return nil, err
		}
		leases = append(leases, lease)
	}
	return leases, rows.Err()
}

func (p *Postgres) MarkBrowserCloseSent(ctx context.Context, sessionID string) error {
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_leases SET close_sent_at=now() WHERE session_id=$1 AND NOT reclaimed`, sessionID)
	return err
}

func (p *Postgres) BrowserReady(ctx context.Context, managerID, epoch, sessionID, leaseID string) error {
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_leases SET state='ready' WHERE session_id=$1 AND lease_id=$2
		AND manager_id=$3 AND manager_epoch=$4 AND state='opening' AND NOT reclaimed AND deadline_at>now()`, sessionID, leaseID, managerID, epoch)
	return err
}

func (p *Postgres) BrowserOpenRejected(ctx context.Context, managerID, epoch, sessionID, leaseID string) error {
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closed',reclaimed=true WHERE session_id=$1 AND lease_id=$2
		AND manager_id=$3 AND manager_epoch=$4 AND state='opening'`, sessionID, leaseID, managerID, epoch)
	return err
}

func (p *Postgres) BrowserClosed(ctx context.Context, managerID, sessionID, leaseID string, reclaimed bool) error {
	if reclaimed {
		_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closed',reclaimed=true WHERE session_id=$1 AND lease_id=$2
			AND manager_id=$3 AND NOT reclaimed`, sessionID, leaseID, managerID)
		return err
	}
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_leases SET state='reclaim_pending' WHERE session_id=$1 AND lease_id=$2
		AND manager_id=$3 AND NOT reclaimed`, sessionID, leaseID, managerID)
	return err
}

func browserCallHash(name string, args []byte) [32]byte {
	return sha256.Sum256(append(append([]byte(name), 0), args...))
}

func (lease BrowserLease) accountToolPinned() bool {
	registry, err := loadToolRegistry()
	if err != nil || registry.Version != lease.RegistryVersion || registry.SHA256 != lease.RegistrySHA256 {
		return false
	}
	tool, ok := registry.tool(browserLoginAccountTool)
	return ok && mcpToolConnected(tool)
}

func accountToolPayload(account, target string) []byte {
	return []byte(jsonText(map[string]string{"accountId": account, "targetOrigin": target}))
}

func (p *Postgres) ReserveBrowserCall(ctx context.Context, token AgentToken, lease BrowserLease, callID, name string, args []byte, authorRunID *string) (bool, error) {
	if !ValidID(callID) || !ValidID(lease.SessionID) || !ValidID(lease.LeaseID) {
		return false, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	w, err := p.lockBrowserWorkspace(ctx, tx, token.WorkspaceID)
	if err != nil {
		return false, err
	}
	var revoked sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT revoked_at FROM agent_tokens WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, token.ID, token.WorkspaceID).Scan(&revoked); err != nil || revoked.Valid {
		return false, ErrNotFound
	}
	locked, err := scanBrowserLease(tx.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases
		WHERE session_id=$1 AND lease_id=$2 AND token_id=$3 AND workspace_id=$4 FOR UPDATE`, lease.SessionID, lease.LeaseID, token.ID, token.WorkspaceID))
	if err != nil {
		return false, err
	}
	if locked.State != "ready" || locked.Reclaimed || stringValue(locked.AuthorRunID) != stringValue(authorRunID) {
		return false, ErrConflict
	}
	if !locked.DeadlineAt.After(time.Now()) {
		return false, errBrowserScopeInvalid
	}
	snapshot, err := browserLeaseScope(ctx, tx, w, locked)
	if err != nil {
		return false, err
	}
	if name == browserLoginAccountTool {
		account, target, err := decodeAccountToolArguments(args)
		if err != nil || !p.readyForWorkspaceLogin() || !locked.accountToolPinned() {
			return false, ErrCredentialUnavailable
		}
		binding := snapshotAccountBinding(snapshot, w.ID, account, target)
		if binding == nil {
			return false, ErrCredentialUnavailable
		}
		if err := formalAccountBindingAllowed(ctx, tx, w, *binding); err != nil {
			return false, err
		}
		args = accountToolPayload(account, target)
	}
	hash := browserCallHash(name, args)
	var prior []byte
	err = tx.QueryRowContext(ctx, `SELECT request_hash FROM agent_browser_calls WHERE session_id=$1 AND call_id=$2`, lease.SessionID, callID).Scan(&prior)
	if err == nil {
		if !bytes.Equal(prior, hash[:]) {
			return false, ErrInvalid
		}
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	var pending bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM agent_browser_calls WHERE session_id=$1 AND state='sent')`, lease.SessionID).Scan(&pending); err != nil {
		return false, err
	}
	if pending {
		return false, errBrowserBusy
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO agent_browser_calls(session_id,call_id,request_hash,state) VALUES($1,$2,$3,'sent')`, lease.SessionID, callID, hash[:]); err != nil {
		return false, dbError(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_leases SET last_activity_at=now() WHERE session_id=$1`, lease.SessionID); err != nil {
		return false, err
	}
	return false, tx.Commit()
}

func (p *Postgres) CompleteBrowserCall(ctx context.Context, sessionID, callID, fixedError string) error {
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_calls SET state='replied',reply_error=$3
		WHERE session_id=$1 AND call_id=$2 AND state='sent'`, sessionID, callID, fixedError)
	return err
}

func (p *Postgres) UnknownBrowserCall(ctx context.Context, sessionID, callID string) error {
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_browser_calls SET state='unknown' WHERE session_id=$1 AND call_id=$2 AND state='sent'`, sessionID, callID)
	return err
}
