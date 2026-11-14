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
	SessionID             string          `json:"sessionId"`
	LeaseID               string          `json:"leaseId"`
	State                 string          `json:"state"`
	Reclaimed             bool            `json:"reclaimed"`
	TokenID               string          `json:"-"`
	WorkspaceID           string          `json:"-"`
	ManagerID             string          `json:"-"`
	ManagerEpoch          string          `json:"-"`
	RegistryVersion       string          `json:"-"`
	RegistrySHA256        string          `json:"-"`
	WorkspaceContext      json.RawMessage `json:"-"`
	AuthorizationRevision int64           `json:"-"`
	DeadlineAt            time.Time       `json:"-"`
}

const browserLeaseColumns = `session_id,lease_id,state,reclaimed,token_id,workspace_id,manager_id,manager_epoch,registry_version,registry_sha256,workspace_context,authorization_revision,deadline_at`

func scanBrowserLease(row scanner) (BrowserLease, error) {
	var lease BrowserLease
	err := row.Scan(&lease.SessionID, &lease.LeaseID, &lease.State, &lease.Reclaimed, &lease.TokenID,
		&lease.WorkspaceID, &lease.ManagerID, &lease.ManagerEpoch, &lease.RegistryVersion,
		&lease.RegistrySHA256, &lease.WorkspaceContext, &lease.AuthorizationRevision, &lease.DeadlineAt)
	if err != nil {
		return BrowserLease{}, dbError(err)
	}
	return lease, nil
}

func (p *Postgres) BrowserLeaseByRequest(ctx context.Context, tokenID, requestID string) (BrowserLease, error) {
	return scanBrowserLease(p.DB.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases WHERE token_id=$1 AND request_id=$2`, tokenID, requestID))
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
	if !ValidID(requestID) || !ValidID(epoch) || workspace.ID != token.WorkspaceID || workspace.Lifecycle != "active" || workspace.ScopeStatus != "confirmed" || workspace.Settings == nil || len(workspace.Settings.Targets) == 0 {
		return BrowserLease{}, false, ErrInvalid
	}
	contextJSON, err := json.Marshal(workspaceContext(workspace))
	if err != nil {
		return BrowserLease{}, false, err
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return BrowserLease{}, false, err
	}
	defer tx.Rollback()
	// The request ID remains a tombstone after cleanup. It is checked before capacity.
	previous, err := scanBrowserLease(tx.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases WHERE token_id=$1 AND request_id=$2`, token.ID, requestID))
	if err == nil {
		return previous, true, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return BrowserLease{}, false, err
	}
	var capacity int
	if err := tx.QueryRowContext(ctx, `SELECT capacity FROM managers WHERE id=$1 FOR UPDATE`, managerID).Scan(&capacity); err != nil {
		return BrowserLease{}, false, dbError(err)
	}
	var tokenWorkspace string
	var revoked sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT workspace_id,revoked_at FROM agent_tokens WHERE id=$1 FOR UPDATE`, token.ID).Scan(&tokenWorkspace, &revoked); err != nil || tokenWorkspace != token.WorkspaceID || revoked.Valid {
		return BrowserLease{}, false, ErrNotFound
	}
	// Recheck the authority snapshot while holding the workspace row.
	var lifecycle, scope string
	var revision int64
	var config []byte
	if err := tx.QueryRowContext(ctx, `SELECT lifecycle,scope_status,authorization_revision,canonical_config FROM workspaces WHERE id=$1 FOR SHARE`, token.WorkspaceID).Scan(&lifecycle, &scope, &revision, &config); err != nil {
		return BrowserLease{}, false, dbError(err)
	}
	if lifecycle != "active" || scope != "confirmed" || revision != workspace.AuthorizationRevision || !jsonEqual(config, jsonText(workspace.Settings)) {
		return BrowserLease{}, false, ErrConflict
	}
	// A concurrent open with the same request ID may have won while waiting on Manager.
	previous, err = scanBrowserLease(tx.QueryRowContext(ctx, `SELECT `+browserLeaseColumns+` FROM agent_browser_leases WHERE token_id=$1 AND request_id=$2`, token.ID, requestID))
	if err == nil {
		return previous, true, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return BrowserLease{}, false, err
	}
	var occupied int
	if err := tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM runs WHERE manager_id=$1 AND NOT slot_released)
		+ (SELECT count(*) FROM agent_browser_leases WHERE manager_id=$1 AND NOT reclaimed)`, managerID).Scan(&occupied); err != nil {
		return BrowserLease{}, false, err
	}
	if occupied >= capacity {
		return BrowserLease{}, false, ErrConflict
	}
	lease := BrowserLease{SessionID: NewID(), LeaseID: NewID(), State: "opening", TokenID: token.ID,
		WorkspaceID: token.WorkspaceID, ManagerID: managerID, ManagerEpoch: epoch,
		RegistryVersion: registry.Version, RegistrySHA256: registry.SHA256,
		WorkspaceContext: contextJSON, AuthorizationRevision: revision,
		DeadlineAt: time.Now().Add(30 * time.Minute)}
	_, err = tx.ExecContext(ctx, `INSERT INTO agent_browser_leases(session_id,lease_id,request_id,token_id,workspace_id,manager_id,manager_epoch,
		registry_version,registry_sha256,workspace_context,authorization_revision,state,deadline_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'opening',$12)`, lease.SessionID, lease.LeaseID, requestID,
		lease.TokenID, lease.WorkspaceID, lease.ManagerID, lease.ManagerEpoch, lease.RegistryVersion,
		lease.RegistrySHA256, lease.WorkspaceContext, lease.AuthorizationRevision, lease.DeadlineAt)
	if err != nil {
		return BrowserLease{}, false, dbError(err)
	}
	if err := tx.Commit(); err != nil {
		return BrowserLease{}, false, err
	}
	return lease, false, nil
}

func jsonEqual(raw []byte, expected string) bool {
	var a, b any
	return json.Unmarshal(raw, &a) == nil && json.Unmarshal([]byte(expected), &b) == nil && jsonText(a) == jsonText(b)
}

func (p *Postgres) CloseBrowserLease(ctx context.Context, token AgentToken, sessionID, leaseID string) (BrowserLease, error) {
	if !ValidID(sessionID) || !ValidID(leaseID) {
		return BrowserLease{}, ErrInvalid
	}
	return scanBrowserLease(p.DB.QueryRowContext(ctx, `UPDATE agent_browser_leases SET state=CASE WHEN reclaimed THEN state ELSE 'closing' END
		WHERE session_id=$1 AND lease_id=$2 AND token_id=$3 AND workspace_id=$4
		RETURNING `+browserLeaseColumns, sessionID, leaseID, token.ID, token.WorkspaceID))
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

func (p *Postgres) ReserveBrowserCall(ctx context.Context, token AgentToken, lease BrowserLease, callID, name string, args []byte) (bool, error) {
	if !ValidID(callID) || !ValidID(lease.SessionID) || !ValidID(lease.LeaseID) {
		return false, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var revoked sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT revoked_at FROM agent_tokens WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, token.ID, token.WorkspaceID).Scan(&revoked); err != nil || revoked.Valid {
		return false, ErrNotFound
	}
	var state string
	var deadline time.Time
	var snapshot json.RawMessage
	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT state,deadline_at,workspace_context,authorization_revision FROM agent_browser_leases
		WHERE session_id=$1 AND lease_id=$2 AND token_id=$3 AND workspace_id=$4 FOR UPDATE`, lease.SessionID, lease.LeaseID, token.ID, token.WorkspaceID).Scan(&state, &deadline, &snapshot, &revision); err != nil {
		return false, dbError(err)
	}
	if state != "ready" {
		return false, ErrConflict
	}
	if !deadline.After(time.Now()) {
		return false, errBrowserScopeInvalid
	}
	var lifecycle, scope string
	var currentRevision int64
	var config []byte
	if err := tx.QueryRowContext(ctx, `SELECT lifecycle,scope_status,authorization_revision,canonical_config FROM workspaces WHERE id=$1 FOR SHARE`, token.WorkspaceID).Scan(&lifecycle, &scope, &currentRevision, &config); err != nil {
		return false, dbError(err)
	}
	var saved struct {
		Config json.RawMessage `json:"config"`
	}
	if json.Unmarshal(snapshot, &saved) != nil || lifecycle != "active" || scope != "confirmed" || revision != currentRevision || !jsonEqual(config, string(saved.Config)) {
		return false, errBrowserScopeInvalid
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
