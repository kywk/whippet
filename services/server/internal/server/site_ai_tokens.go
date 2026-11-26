package server

import (
	"context"
	"database/sql"
	"slices"
	"strings"
	"time"
)

type siteAITokenRow struct {
	ID          string
	WorkspaceID string
	Name        string
	Revision    int
	Paused      bool
	Revoked     bool
	Successor   *string
	AgentID     *string
}

func readSiteAIToken(ctx context.Context, q queryDB, id string, lock bool) (siteAITokenRow, error) {
	var out siteAITokenRow
	query := `SELECT id,workspace_id,name,control_revision,claim_paused,revoked_at IS NOT NULL,successor_id,issued_agent_id FROM agent_tokens WHERE id=$1`
	if lock {
		query += ` FOR UPDATE`
	}
	err := q.QueryRowContext(ctx, query, id).Scan(&out.ID, &out.WorkspaceID, &out.Name, &out.Revision, &out.Paused, &out.Revoked, &out.Successor, &out.AgentID)
	return out, dbError(err)
}

func lockSiteAITokenWorkspace(ctx context.Context, tx *sql.Tx, id string) (siteAITokenRow, string, error) {
	var workspace string
	if err := tx.QueryRowContext(ctx, `SELECT workspace_id FROM agent_tokens WHERE id=$1`, id).Scan(&workspace); err != nil {
		return siteAITokenRow{}, "", dbError(err)
	}
	state, _, err := siteAIWorkspaceStatus(ctx, tx, workspace, true)
	if err != nil {
		return siteAITokenRow{}, "", err
	}
	item, err := readSiteAIToken(ctx, tx, id, true)
	return item, state, err
}

type siteAITokenAction struct {
	Revision  int    `json:"revision,omitempty"`
	RunID     string `json:"runId,omitempty"`
	AttemptID string `json:"attemptId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	LeaseID   string `json:"leaseId,omitempty"`
}

func (p *Postgres) changeSiteAIToken(ctx context.Context, actor platformActor, id, action string, body siteAITokenAction) (accepted bool, err error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if err = lockSiteAISuperAdmin(ctx, tx, actor); err != nil {
		return false, err
	}
	item, _, err := lockSiteAITokenWorkspace(ctx, tx, id)
	if err != nil {
		return false, err
	}
	if body.Revision > 0 && body.Revision != item.Revision {
		return false, errSiteAIStale
	}
	switch action {
	case "pause_claim", "resume_claim":
		if item.Revoked {
			return false, ErrConflict
		}
		paused := action == "pause_claim"
		if paused == item.Paused {
			return false, tx.Commit()
		}
		_, err = tx.ExecContext(ctx, `UPDATE agent_tokens SET claim_paused=$2,control_revision=control_revision+1 WHERE id=$1`, id, paused)
	case "revoke_access":
		if item.Revoked {
			return false, tx.Commit()
		}
		err = p.revokeSiteAIToken(ctx, tx, item)
	case "cancel_run":
		var state string
		err = tx.QueryRowContext(ctx, `SELECT state FROM external_author_claims WHERE run_id=$1 AND attempt_id=$2 AND lease_id=$3
 AND token_id=$4 AND workspace_id=$5 FOR UPDATE`, body.RunID, body.AttemptID, body.LeaseID, id, item.WorkspaceID).Scan(&state)
		if err != nil {
			return false, dbError(err)
		}
		if state != "active" {
			return false, tx.Commit()
		}
		err = cancelSiteAIExternalRun(ctx, tx, body.RunID, body.AttemptID)
	case "close_browser":
		err = tx.QueryRowContext(ctx, `UPDATE agent_browser_leases SET state=CASE WHEN reclaimed THEN state ELSE 'closing' END
 WHERE session_id=$1 AND lease_id=$2 AND token_id=$3 AND workspace_id=$4 RETURNING NOT reclaimed`, body.SessionID, body.LeaseID, id, item.WorkspaceID).Scan(&accepted)
		if err == nil && !accepted {
			return false, tx.Commit()
		}
	default:
		return false, errSiteAIAction
	}
	if err != nil {
		return false, dbError(err)
	}
	targetType, target := "token", id
	if action == "cancel_run" {
		targetType, target = "run", body.RunID
	} else if action == "close_browser" {
		targetType, target = "browser_lease", body.LeaseID
	}
	if err = recordSiteAIAction(ctx, tx, actor, action, targetType, target, &item.WorkspaceID, nil); err != nil {
		return false, err
	}
	return accepted, tx.Commit()
}

func cancelSiteAIExternalRun(ctx context.Context, tx *sql.Tx, run, attempt string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET status='cancelled',finished_at=now() WHERE id=$1 AND attempt_id=$2 AND status='running'`, run, attempt); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing' WHERE NOT reclaimed
 AND session_id=(SELECT browser_session_id FROM external_author_claims WHERE run_id=$1 AND attempt_id=$2)`, run, attempt); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE external_author_claims SET state='cancelled' WHERE run_id=$1 AND attempt_id=$2 AND state='active'`, run, attempt)
	return err
}

func (p *Postgres) revokeSiteAIToken(ctx context.Context, tx *sql.Tx, item siteAITokenRow) error {
	if _, err := tx.ExecContext(ctx, `UPDATE agent_tokens SET revoked_at=now(),control_revision=control_revision+1
 WHERE id=$1 AND revoked_at IS NULL`, item.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing'
 WHERE token_id=$1 AND workspace_id=$2 AND NOT reclaimed`, item.ID, item.WorkspaceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_browser_calls SET state='unknown' WHERE state='sent' AND session_id IN
 (SELECT session_id FROM agent_browser_leases WHERE token_id=$1 AND workspace_id=$2 AND NOT reclaimed)`, item.ID, item.WorkspaceID); err != nil {
		return err
	}
	if err := p.RevokeExternalClaims(ctx, tx, item.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs r SET status='cancelled',finished_at=now(),error='agent_token_revoked' FROM site_ai_run_bindings b
 WHERE r.id=b.run_id AND b.token_id=$1 AND r.status='queued'`, item.ID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE site_ai_agents SET status='disabled',reason='token_revoked',revision=revision+1,
 verified_at=NULL,verified_skills='{}',updated_at=now() WHERE token_id=$1`, item.ID)
	return err
}

type siteAIReissueRequest struct {
	Revision    int    `json:"revision"`
	WorkspaceID string `json:"workspaceId"`
	RequestID   string `json:"requestId"`
}

type siteAIReissueResult struct {
	Resource siteAIResource `json:"resource"`
	Agent    *siteAIAgent   `json:"agent"`
	Token    string         `json:"token,omitempty"`
}

func readSiteAIReissueResult(ctx context.Context, q queryDB, tokenID, secret string) (siteAIReissueResult, error) {
	item, err := readSiteAIResource(ctx, q, "mcp:"+tokenID, siteAIConnectionView{})
	if err != nil {
		return siteAIReissueResult{}, err
	}
	result := siteAIReissueResult{Resource: item, Token: secret}
	if item.AgentID != nil {
		row, err := readSiteAIAgent(ctx, q, *item.AgentID, false)
		if err != nil {
			return siteAIReissueResult{}, err
		}
		a := presentSiteAIAgent(row, siteAIConnectionView{}, time.Now())
		result.Agent = &a
	}
	return result, nil
}

func (p *Postgres) reissueSiteAIToken(ctx context.Context, actor platformActor, tokenID string, req siteAIReissueRequest, enabled bool) (siteAIReissueResult, bool, error) {
	req.WorkspaceID, req.RequestID = strings.ToLower(req.WorkspaceID), strings.ToLower(req.RequestID)
	digest, err := siteAIRequestDigest(struct {
		TokenID string `json:"tokenId"`
		siteAIReissueRequest
	}{tokenID, req}, nil)
	if err != nil {
		return siteAIReissueResult{}, false, err
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return siteAIReissueResult{}, false, err
	}
	defer tx.Rollback()
	if err = lockSiteAISuperAdmin(ctx, tx, actor); err != nil {
		return siteAIReissueResult{}, false, err
	}
	prior, err := lockSiteAIRequest(ctx, tx, actor, "reissue_access", req.RequestID, digest)
	if err != nil {
		return siteAIReissueResult{}, false, err
	}
	if prior != "" {
		result, err := readSiteAIReissueResult(ctx, tx, prior, "")
		return result, false, err
	}
	if !enabled {
		return siteAIReissueResult{}, false, errSiteAIDisabled
	}
	item, err := readSiteAIToken(ctx, tx, tokenID, false)
	if err != nil {
		return siteAIReissueResult{}, false, err
	}
	workspaces := []string{item.WorkspaceID, req.WorkspaceID}
	slices.Sort(workspaces)
	for _, id := range slices.Compact(workspaces) {
		state, _, err := siteAIWorkspaceStatus(ctx, tx, id, true)
		if err != nil {
			return siteAIReissueResult{}, false, err
		}
		if id == req.WorkspaceID {
			if err := siteAIWorkspaceError(state); err != nil {
				return siteAIReissueResult{}, false, err
			}
		}
	}
	item, err = readSiteAIToken(ctx, tx, tokenID, true)
	if err != nil {
		return siteAIReissueResult{}, false, err
	}
	if item.Revision != req.Revision {
		return siteAIReissueResult{}, false, errSiteAIStale
	}
	if item.Successor != nil {
		return siteAIReissueResult{}, false, ErrConflict
	}
	var busy bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM external_author_claims WHERE token_id=$1 AND state='active')
 OR EXISTS(SELECT 1 FROM agent_browser_leases WHERE token_id=$1 AND NOT reclaimed)`, item.ID).Scan(&busy); err != nil {
		return siteAIReissueResult{}, false, err
	}
	if busy {
		return siteAIReissueResult{}, false, errSiteAIBusy
	}
	if !item.Revoked {
		if err = p.revokeSiteAIToken(ctx, tx, item); err != nil {
			return siteAIReissueResult{}, false, err
		}
	}
	newID, secret, err := insertSiteAIToken(ctx, tx, req.WorkspaceID, item.Name)
	if err != nil {
		return siteAIReissueResult{}, false, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE agent_tokens SET successor_id=$2,control_revision=$3 WHERE id=$1`, item.ID, newID, item.Revision+1); err != nil {
		return siteAIReissueResult{}, false, err
	}
	if item.AgentID != nil {
		agentID := *item.AgentID
		if item.WorkspaceID == req.WorkspaceID {
			_, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET token_id=$2,status='waiting_connection',reason=NULL,probe_id=NULL,
 verified_at=NULL,verified_skills='{}',revision=revision+CASE WHEN $3 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1`, agentID, newID, item.Revoked)
		} else {
			agentID = NewID()
			_, err = tx.ExecContext(ctx, `INSERT INTO site_ai_agents(id,workspace_id,name,mode,engine,provider,model,token_id,status)
 SELECT $1,$2,name,mode,engine,provider,model,$3,'waiting_connection' FROM site_ai_agents WHERE id=$4`, agentID, req.WorkspaceID, newID, item.AgentID)
		}
		if err != nil {
			return siteAIReissueResult{}, false, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE agent_tokens SET issued_agent_id=$2 WHERE id=$1`, newID, agentID); err != nil {
			return siteAIReissueResult{}, false, err
		}
	}
	if err = saveSiteAIRequest(ctx, tx, actor, "reissue_access", req.RequestID, digest, newID); err != nil {
		return siteAIReissueResult{}, false, err
	}
	if err = recordSiteAIAction(ctx, tx, actor, "reissue_access", "token", item.ID, &req.WorkspaceID, &req.RequestID); err != nil {
		return siteAIReissueResult{}, false, err
	}
	result, err := readSiteAIReissueResult(ctx, tx, newID, secret)
	if err != nil {
		return siteAIReissueResult{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return siteAIReissueResult{}, false, err
	}
	return result, true, nil
}
