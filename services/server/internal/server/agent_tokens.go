package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
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
	item, err := scanAgentToken(p.DB.QueryRowContext(ctx, `INSERT INTO agent_tokens(id,workspace_id,name,token_hash)
		SELECT $1,id,$3,$4 FROM workspaces WHERE id=$2 RETURNING `+agentTokenColumns, NewID(), workspace, name, digest[:]))
	if err != nil {
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
	var got string
	err := p.DB.QueryRowContext(ctx, `UPDATE agent_tokens SET revoked_at=COALESCE(revoked_at,now())
		WHERE id=$1 AND workspace_id=$2 RETURNING id`, id, workspace).Scan(&got)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
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
