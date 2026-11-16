package server

import (
	"context"
	"encoding/base64"
	"strings"
	"time"
)

type AgentToolAudit struct {
	ID          string    `json:"id"`
	TokenID     string    `json:"tokenId"`
	WorkspaceID string    `json:"workspaceId"`
	ToolName    string    `json:"toolName"`
	Decision    string    `json:"decision"`
	OccurredAt  time.Time `json:"occurredAt"`
}

func (p *Postgres) RecordAgentToolAudit(ctx context.Context, token AgentToken, name, decision string) error {
	if name != "catalog_search" && name != "catalog_get" {
		name = "unknown"
	}
	switch decision {
	case "allowed", "denied", "failed", "rate_limited":
	default:
		return ErrInvalid
	}
	_, err := p.DB.ExecContext(ctx, `INSERT INTO agent_tool_audit(id,token_id,workspace_id,tool_name,decision) VALUES($1,$2,$3,$4,$5)`, NewID(), token.ID, token.WorkspaceID, name, decision)
	return err
}

func (p *Postgres) AgentToolAudits(ctx context.Context, workspace string, limit int, before string) ([]AgentToolAudit, *string, error) {
	if !ValidID(workspace) || limit < 1 || limit > 100 {
		return nil, nil, ErrInvalid
	}
	var beforeTime any
	var beforeID any
	if before != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(before)
		parts := strings.Split(string(decoded), ":")
		if err != nil || len(parts) != 2 || parts[0] != workspace || !ValidID(parts[1]) {
			return nil, nil, ErrInvalid
		}
		var t time.Time
		if err := p.DB.QueryRowContext(ctx, `SELECT occurred_at FROM agent_tool_audit WHERE id=$1 AND workspace_id=$2`, parts[1], workspace).Scan(&t); err != nil {
			return nil, nil, ErrInvalid
		}
		beforeTime, beforeID = t, parts[1]
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT id,token_id,workspace_id,tool_name,decision,occurred_at FROM agent_tool_audit
		WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR (occurred_at,id)<($2::timestamptz,$3::uuid)) ORDER BY occurred_at DESC,id DESC LIMIT $4`, workspace, beforeTime, beforeID, limit+1)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := []AgentToolAudit{}
	for rows.Next() {
		var item AgentToolAudit
		if err := rows.Scan(&item.ID, &item.TokenID, &item.WorkspaceID, &item.ToolName, &item.Decision, &item.OccurredAt); err != nil {
			return nil, nil, err
		}
		item.OccurredAt = item.OccurredAt.UTC()
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		cursor := base64.RawURLEncoding.EncodeToString([]byte(workspace + ":" + items[len(items)-1].ID))
		next = &cursor
	}
	return items, next, nil
}
