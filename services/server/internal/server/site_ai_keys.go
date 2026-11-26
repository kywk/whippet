package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"time"
)

func siteAIKeyAAD(workspace, agent string, version int) []byte {
	return []byte(fmt.Sprintf("whippet-agent-key-v1:%s:%s:%d", workspace, agent, version))
}

func (v *SecretVault) sealSiteAIKey(workspace, agent string, version int, key string) (nonce, ciphertext []byte, err error) {
	if v == nil {
		return nil, nil, ErrSecretsUnavailable
	}
	nonce = make([]byte, v.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, ErrSecretsUnavailable
	}
	plaintext := []byte(key)
	defer clear(plaintext)
	return nonce, v.aead.Seal(nil, nonce, plaintext, siteAIKeyAAD(workspace, agent, version)), nil
}

func (v *SecretVault) openSiteAIKey(workspace, agent string, version int, nonce, ciphertext []byte) (string, error) {
	if v == nil || len(nonce) != v.aead.NonceSize() {
		return "", ErrSecretsUnavailable
	}
	key, err := v.aead.Open(nil, nonce, ciphertext, siteAIKeyAAD(workspace, agent, version))
	if err != nil {
		return "", ErrSecretsUnavailable
	}
	defer clear(key)
	return string(key), nil
}

func (p *Postgres) storeSiteAIKey(ctx context.Context, tx *sql.Tx, workspace, agent string, version int, key string) error {
	nonce, ciphertext, err := p.Secrets.sealSiteAIKey(workspace, agent, version, key)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO site_ai_agent_keys(agent_id,workspace_id,version,nonce,ciphertext) VALUES($1,$2,$3,$4,$5)`,
		agent, workspace, version, nonce, ciphertext)
	return err
}

func (p *Postgres) changeSiteAIKey(ctx context.Context, actor platformActor, id string, expected int, key *string, conn siteAIConnectionView) (siteAIAgent, error) {
	if expected < 0 || key != nil && !validSiteAIKey(*key) {
		return siteAIAgent{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return siteAIAgent{}, err
	}
	defer tx.Rollback()
	if err = lockSiteAISuperAdmin(ctx, tx, actor); err != nil {
		return siteAIAgent{}, err
	}
	item, err := lockSiteAIAgentWorkspace(ctx, tx, id, key != nil)
	if err != nil {
		return siteAIAgent{}, err
	}
	if item.ModelKey == nil || item.ModelKey.Version == nil {
		return siteAIAgent{}, errSiteAIAction
	}
	if *item.ModelKey.Version != expected {
		return siteAIAgent{}, errSiteAIStale
	}
	if key == nil && !item.ModelKey.Configured {
		return presentSiteAIAgent(item, conn, time.Now()), tx.Commit()
	}
	if _, err = tx.ExecContext(ctx, `UPDATE site_ai_agent_keys SET revoked_at=now()
 WHERE agent_id=$1 AND workspace_id=$2 AND version=$3 AND revoked_at IS NULL`, id, item.WorkspaceID, expected); err != nil {
		return siteAIAgent{}, err
	}
	if err = cancelSiteAIProvisions(ctx, tx, "agent_id", id, true); err != nil {
		return siteAIAgent{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE runs r SET status=CASE WHEN r.status='queued' THEN 'cancelled' ELSE 'cancelling' END,
 finished_at=CASE WHEN r.status='queued' THEN now() ELSE r.finished_at END,error='agent_key_revoked' FROM site_ai_run_bindings b
 WHERE r.id=b.run_id AND b.agent_id=$1 AND b.secret_version=$2 AND r.status IN ('queued','dispatched','running','collecting')`, id, expected); err != nil {
		return siteAIAgent{}, err
	}
	status, reason, action := siteAIUnavailable, "key_missing", "revoke_model_key"
	if key != nil {
		if err = p.storeSiteAIKey(ctx, tx, item.WorkspaceID, id, expected+1, *key); err != nil {
			return siteAIAgent{}, err
		}
		status, reason, action = siteAIFailed, "verification_required", "rotate_model_key"
	}
	if _, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET key_version=key_version+1,key_configured=$2,
 status=$3,reason=$4,verified_at=NULL,verified_skills='{}',verified_manager_id=NULL,verified_worker_revision=NULL,
 revision=revision+1,updated_at=now() WHERE id=$1`, id, key != nil, status, reason); err != nil {
		return siteAIAgent{}, err
	}
	if err = recordSiteAIAction(ctx, tx, actor, action, "agent", id, &item.WorkspaceID, nil); err != nil {
		return siteAIAgent{}, err
	}
	return commitSiteAIAgent(ctx, tx, id, conn)
}

type siteAIModelCredential struct {
	AgentID       string `json:"agentId"`
	SecretVersion int    `json:"secretVersion"`
}

type siteAIKeyRequest struct {
	siteAIModelCredential
	Purpose     string `json:"purpose"`
	RunID       string `json:"runId,omitempty"`
	AttemptID   string `json:"attemptId,omitempty"`
	OperationID string `json:"operationId,omitempty"`
}

func (r siteAIKeyRequest) valid() bool {
	if !ValidID(r.AgentID) || r.SecretVersion < 1 {
		return false
	}
	if r.Purpose == "run" {
		return ValidID(r.RunID) && ValidID(r.AttemptID) && r.OperationID == ""
	}
	return r.Purpose == "probe" && ValidID(r.OperationID) && r.RunID == "" && r.AttemptID == ""
}

type siteAIKeyResolution struct {
	siteAIKeyRequest
	WorkspaceID string `json:"workspaceId"`
	APIKey      string `json:"apiKey"`
}

func (p *Postgres) resolveSiteAIKey(ctx context.Context, conn siteAIConnectionView, req siteAIKeyRequest) (siteAIKeyResolution, error) {
	if !req.valid() {
		return siteAIKeyResolution{}, ErrInvalid
	}
	if !conn.online(time.Now()) || conn.Nonce == "" {
		return siteAIKeyResolution{}, ErrCredentialUnavailable
	}
	if p.Secrets == nil {
		return siteAIKeyResolution{}, ErrSecretsUnavailable
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return siteAIKeyResolution{}, err
	}
	defer tx.Rollback()
	var workspace string
	if req.Purpose == "run" {
		err = tx.QueryRowContext(ctx, `SELECT workspace_id FROM site_ai_run_bindings WHERE run_id=$1 AND agent_id=$2 AND token_id IS NULL`, req.RunID, req.AgentID).Scan(&workspace)
	} else {
		err = tx.QueryRowContext(ctx, `SELECT workspace_id FROM site_ai_provisions WHERE id=$1 AND agent_id=$2`, req.OperationID, req.AgentID).Scan(&workspace)
	}
	if err != nil {
		return siteAIKeyResolution{}, dbError(err)
	}
	state, mode, err := siteAIWorkspaceStatus(ctx, tx, workspace, true)
	if err != nil {
		return siteAIKeyResolution{}, err
	}
	if state != "active" && (state != "archiving" || mode != "drain") {
		return siteAIKeyResolution{}, ErrCredentialUnavailable
	}
	var eligible bool
	if req.Purpose == "run" {
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runs r JOIN site_ai_run_bindings b ON b.run_id=r.id
 WHERE r.id=$1 AND r.attempt_id=$2 AND r.manager_id=$3 AND r.workspace_id=$4 AND b.agent_id=$5 AND b.secret_version=$6
 AND r.kind='author' AND r.status IN ('dispatched','running') AND NOT r.slot_released)`,
			req.RunID, req.AttemptID, conn.ManagerID, workspace, req.AgentID, req.SecretVersion).Scan(&eligible)
	} else {
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM site_ai_provisions
 WHERE id=$1 AND manager_id=$2 AND manager_epoch=$3 AND workspace_id=$4 AND agent_id=$5 AND secret_version=$6
 AND state='sent' AND NOT reclaimed AND deadline_at>now())`, req.OperationID, conn.ManagerID, conn.Epoch, workspace, req.AgentID, req.SecretVersion).Scan(&eligible)
	}
	if err != nil {
		return siteAIKeyResolution{}, err
	}
	if !eligible {
		return siteAIKeyResolution{}, ErrCredentialUnavailable
	}
	var nonce, ciphertext []byte
	var engine string
	err = tx.QueryRowContext(ctx, `SELECT k.nonce,k.ciphertext,a.engine FROM site_ai_agent_keys k JOIN site_ai_agents a ON a.id=k.agent_id
 WHERE k.workspace_id=$1 AND k.agent_id=$2 AND k.version=$3 AND k.revoked_at IS NULL AND a.key_configured AND a.key_version=k.version`,
		workspace, req.AgentID, req.SecretVersion).Scan(&nonce, &ciphertext, &engine)
	if err == sql.ErrNoRows || err == nil && !conn.supports(engine) {
		return siteAIKeyResolution{}, ErrCredentialUnavailable
	}
	if err != nil {
		return siteAIKeyResolution{}, err
	}
	key, err := p.Secrets.openSiteAIKey(workspace, req.AgentID, req.SecretVersion, nonce, ciphertext)
	if err != nil {
		return siteAIKeyResolution{}, err
	}
	return siteAIKeyResolution{siteAIKeyRequest: req, WorkspaceID: workspace, APIKey: key}, tx.Commit()
}
