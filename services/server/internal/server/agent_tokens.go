package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"strings"
	"time"
	"unicode/utf8"
)

type AgentToken struct {
	ID          string     `json:"id"`
	WorkspaceID string     `json:"workspaceId"`
	Name        string     `json:"name"`
	CreatedAt   time.Time  `json:"createdAt"`
	RevokedAt   *time.Time `json:"revokedAt"`
	LastUsedAt  *time.Time `json:"lastUsedAt"`
}

const agentTokenColumns = `id,workspace_id,name,created_at,revoked_at,last_used_at`

func scanAgentToken(row scanner) (AgentToken, error) {
	var item AgentToken
	var revoked, used sql.NullTime
	err := row.Scan(&item.ID, &item.WorkspaceID, &item.Name, &item.CreatedAt, &revoked, &used)
	if err != nil {
		return AgentToken{}, dbError(err)
	}
	item.CreatedAt = item.CreatedAt.UTC()
	if revoked.Valid {
		t := revoked.Time.UTC()
		item.RevokedAt = &t
	}
	if used.Valid {
		t := used.Time.UTC()
		item.LastUsedAt = &t
	}
	return item, nil
}

func validAgentTokenName(name string) bool {
	return name != "" && utf8.ValidString(name) && !strings.ContainsRune(name, 0) && utf8.RuneCountInString(name) <= 100
}

func authorizeAgentTokenManager(ctx context.Context, tx *sql.Tx) error {
	actor := actorFromContext(ctx)
	if actor.user.ID == "" {
		return nil
	}
	role, err := lockActorSiteRole(ctx, tx, actor)
	if err != nil {
		return err
	}
	if role != superAdmin {
		return errForbidden
	}
	return nil
}

func (p *Postgres) CreateAgentToken(ctx context.Context, workspace, name string) (AgentToken, string, error) {
	name = strings.TrimSpace(name)
	if !ValidID(workspace) || !validAgentTokenName(name) {
		return AgentToken{}, "", ErrInvalid
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return AgentToken{}, "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(raw[:])
	digest := sha256.Sum256([]byte(secret))
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return AgentToken{}, "", err
	}
	defer tx.Rollback()
	if err := authorizeAgentTokenManager(ctx, tx); err != nil {
		return AgentToken{}, "", err
	}
	if err := requireActiveWorkspace(ctx, tx, workspace); err != nil {
		return AgentToken{}, "", err
	}
	item, err := scanAgentToken(tx.QueryRowContext(ctx, `INSERT INTO agent_tokens(id,workspace_id,name,token_hash)
		SELECT $1,id,$3,$4 FROM workspaces WHERE id=$2 RETURNING `+agentTokenColumns, NewID(), workspace, name, digest[:]))
	if err != nil {
		return AgentToken{}, "", err
	}
	if err := platformAudit(actorFromContext(ctx), "create_agent_token", "agent_token", item.ID, &workspace).record(ctx, tx, "succeeded", nil); err != nil {
		return AgentToken{}, "", err
	}
	if err := tx.Commit(); err != nil {
		return AgentToken{}, "", err
	}
	return item, secret, nil
}

func (p *Postgres) AgentTokens(ctx context.Context, workspace string) ([]AgentToken, error) {
	var exists bool
	if err := p.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)`, workspace).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT `+agentTokenColumns+` FROM agent_tokens WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC`, workspace)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AgentToken{}
	for rows.Next() {
		item, err := scanAgentToken(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (p *Postgres) RevokeAgentToken(ctx context.Context, workspace, id string) error {
	if !ValidID(workspace) || !ValidID(id) {
		return ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := authorizeAgentTokenManager(ctx, tx); err != nil {
		return err
	}
	if _, err := lockWorkspaceWorkStatus(ctx, tx, workspace); err != nil {
		return err
	}
	var alreadyRevoked bool
	if err := tx.QueryRowContext(ctx, `SELECT revoked_at IS NOT NULL FROM agent_tokens WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, id, workspace).Scan(&alreadyRevoked); err != nil {
		return dbError(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND workspace_id=$2`, id, workspace); err != nil {
		return err
	}
	if err := p.RevokeExternalClaims(ctx, tx, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing'
		WHERE token_id=$1 AND workspace_id=$2 AND NOT reclaimed`, id, workspace); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_calls SET state='unknown' WHERE state='sent' AND session_id IN
		(SELECT session_id FROM agent_browser_leases WHERE token_id=$1 AND workspace_id=$2 AND NOT reclaimed)`, id, workspace); err != nil {
		return err
	}
	if !alreadyRevoked {
		if err := platformAudit(actorFromContext(ctx), "revoke_agent_token", "agent_token", id, &workspace).record(ctx, tx, "succeeded", nil); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (p *Postgres) AuthorizeAgentToken(ctx context.Context, secret string) (AgentToken, error) {
	if len(secret) != 43 {
		return AgentToken{}, ErrNotFound
	}
	digest := sha256.Sum256([]byte(secret))
	item, err := scanAgentToken(p.DB.QueryRowContext(ctx, `UPDATE agent_tokens SET last_used_at=now()
		WHERE token_hash=$1 AND revoked_at IS NULL RETURNING `+agentTokenColumns, digest[:]))
	if err != nil {
		return AgentToken{}, ErrNotFound
	}
	return item, nil
}
