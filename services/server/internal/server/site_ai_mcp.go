package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/lib/pq"
)

const siteAIMCPRegistrationLifetime = 90 * time.Second

type siteAIMCPRegisterRequest struct {
	Engine   string   `json:"engine"`
	Provider string   `json:"provider"`
	Model    string   `json:"model"`
	Skills   []string `json:"skillIds"`
}

type siteAIMCPChallenge struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type siteAIMCPRegistration struct {
	ID                  string              `json:"registrationId"`
	HeartbeatIntervalMS int                 `json:"heartbeatIntervalMs"`
	ExpiresAt           time.Time           `json:"expiresAt"`
	Challenge           *siteAIMCPChallenge `json:"challenge"`
}

type siteAIMCPRegistrationRow struct {
	siteAIMCPRegistration
	siteAIMCPRegisterRequest
	ProbeStatus *string
}

func readSiteAIMCPRegistration(ctx context.Context, q queryDB, tokenID string) (siteAIMCPRegistrationRow, error) {
	item := siteAIMCPRegistrationRow{}
	var skills pq.StringArray
	var challengeID *string
	var challengeExpires *time.Time
	err := q.QueryRowContext(ctx, `SELECT id,engine,provider,model,skills,expires_at,challenge_id,challenge_expires_at,probe_status
 FROM site_ai_mcp_registrations WHERE token_id=$1`, tokenID).
		Scan(&item.ID, &item.Engine, &item.Provider, &item.Model, &skills, &item.ExpiresAt, &challengeID, &challengeExpires, &item.ProbeStatus)
	if err != nil {
		return item, dbError(err)
	}
	item.Skills, item.HeartbeatIntervalMS, item.ExpiresAt = skills, 30000, item.ExpiresAt.UTC()
	if challengeID != nil {
		item.Challenge = &siteAIMCPChallenge{ID: *challengeID, ExpiresAt: challengeExpires.UTC()}
	}
	return item, nil
}

func lockSiteAIMCPToken(ctx context.Context, tx *sql.Tx, token AgentToken) (siteAITokenRow, error) {
	if err := activeSiteAIWorkspace(ctx, tx, token.WorkspaceID); err != nil {
		return siteAITokenRow{}, err
	}
	item, err := readSiteAIToken(ctx, tx, token.ID, true)
	if err == nil && (item.Revoked || item.WorkspaceID != token.WorkspaceID) {
		err = ErrNotFound
	}
	return item, err
}

func (p *Postgres) registerSiteAIMCP(ctx context.Context, token AgentToken, request siteAIMCPRegisterRequest) (siteAIMCPRegistration, error) {
	if !validSiteAIEngine(request.Engine) || !validSiteAIProvider(request.Provider) || !validSiteAIModel(request.Model) ||
		!validSiteAIEnumList(request.Skills, siteAIPrimarySkills) {
		return siteAIMCPRegistration{}, ErrInvalid
	}
	slices.Sort(request.Skills)
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return siteAIMCPRegistration{}, err
	}
	defer tx.Rollback()
	item, err := lockSiteAIMCPToken(ctx, tx, token)
	if err != nil {
		return siteAIMCPRegistration{}, err
	}
	now := time.Now().UTC()
	prior, err := readSiteAIMCPRegistration(ctx, tx, token.ID)
	if err == nil && now.Before(prior.ExpiresAt) {
		if prior.Engine != request.Engine || prior.Provider != request.Provider || prior.Model != request.Model || !slices.Equal(prior.Skills, request.Skills) {
			return siteAIMCPRegistration{}, ErrConflict
		}
		if prior.ProbeStatus != nil || prior.Challenge != nil && !now.Before(prior.Challenge.ExpiresAt) {
			prior.Challenge = nil
		}
		return prior.siteAIMCPRegistration, tx.Commit()
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return siteAIMCPRegistration{}, err
	}
	out := siteAIMCPRegistration{ID: NewID(), HeartbeatIntervalMS: 30000, ExpiresAt: now.Add(siteAIMCPRegistrationLifetime)}
	var challengeID *string
	var challengeExpires *time.Time
	if item.AgentID != nil {
		agent, err := readSiteAIAgent(ctx, tx, *item.AgentID, true)
		if err != nil {
			return siteAIMCPRegistration{}, err
		}
		if agent.TokenID == nil || *agent.TokenID != token.ID || agent.WorkspaceID != token.WorkspaceID {
			return siteAIMCPRegistration{}, ErrNotFound
		}
		if request.Engine != agent.Engine || request.Provider != agent.Provider || request.Model != agent.Model || !slices.Equal(request.Skills, []string{"test-author"}) {
			if _, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET status='failed',reason='engine_mismatch',verified_at=NULL,verified_skills='{}',updated_at=now()
 WHERE id=$1`, agent.ID); err != nil {
				return siteAIMCPRegistration{}, err
			}
			if err = tx.Commit(); err != nil {
				return siteAIMCPRegistration{}, err
			}
			return siteAIMCPRegistration{}, ErrConflict
		}
		out.Challenge = &siteAIMCPChallenge{ID: NewID(), ExpiresAt: now.Add(siteAIProbeTime)}
		challengeID, challengeExpires = &out.Challenge.ID, &out.Challenge.ExpiresAt
		if _, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET status='verifying',reason=NULL,probe_id=$2,verified_at=NULL,verified_skills='{}',updated_at=now()
 WHERE id=$1`, agent.ID, challengeID); err != nil {
			return siteAIMCPRegistration{}, err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO site_ai_mcp_registrations(token_id,id,engine,provider,model,skills,expires_at,challenge_id,challenge_expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(token_id) DO UPDATE SET id=EXCLUDED.id,engine=EXCLUDED.engine,
 provider=EXCLUDED.provider,model=EXCLUDED.model,skills=EXCLUDED.skills,expires_at=EXCLUDED.expires_at,
 challenge_id=EXCLUDED.challenge_id,challenge_expires_at=EXCLUDED.challenge_expires_at,probe_status=NULL`, token.ID, out.ID,
		request.Engine, request.Provider, request.Model, pq.Array(request.Skills), out.ExpiresAt, challengeID, challengeExpires)
	if err != nil {
		return siteAIMCPRegistration{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE agent_tokens SET claim_at=now() WHERE id=$1`, token.ID); err != nil {
		return siteAIMCPRegistration{}, err
	}
	return out, tx.Commit()
}

type siteAIMCPProbeRequest struct {
	RegistrationID string `json:"registrationId"`
	ChallengeID    string `json:"challengeId"`
	Status         string `json:"status"`
}

type siteAIMCPProbeResult struct {
	Status string  `json:"status"`
	Reason *string `json:"reason"`
}

func (p *Postgres) reportSiteAIMCPProbe(ctx context.Context, token AgentToken, request siteAIMCPProbeRequest) (siteAIMCPProbeResult, error) {
	if !ValidID(request.RegistrationID) || !ValidID(request.ChallengeID) ||
		!slices.Contains([]string{"passed", "provider_auth_failed", "provider_unavailable", "probe_failed"}, request.Status) {
		return siteAIMCPProbeResult{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return siteAIMCPProbeResult{}, err
	}
	defer tx.Rollback()
	item, err := lockSiteAIMCPToken(ctx, tx, token)
	if err != nil {
		return siteAIMCPProbeResult{}, err
	}
	if item.AgentID == nil {
		return siteAIMCPProbeResult{}, ErrConflict
	}
	reg, err := readSiteAIMCPRegistration(ctx, tx, token.ID)
	if errors.Is(err, ErrNotFound) || err == nil && (reg.ID != request.RegistrationID || reg.Challenge == nil || reg.Challenge.ID != request.ChallengeID) {
		return siteAIMCPProbeResult{}, ErrConflict
	}
	if err != nil {
		return siteAIMCPProbeResult{}, err
	}
	if reg.ProbeStatus != nil {
		if stringValue(reg.ProbeStatus) != request.Status {
			return siteAIMCPProbeResult{}, ErrConflict
		}
		row, err := readSiteAIAgent(ctx, tx, *item.AgentID, false)
		if err != nil {
			return siteAIMCPProbeResult{}, err
		}
		presented := presentSiteAIAgent(row, siteAIConnectionView{}, time.Now())
		return siteAIMCPProbeResult{Status: presented.Status, Reason: presented.Reason}, tx.Commit()
	}
	now := time.Now().UTC()
	if !now.Before(reg.ExpiresAt) || !now.Before(reg.Challenge.ExpiresAt) {
		return siteAIMCPProbeResult{}, ErrConflict
	}
	result := siteAIMCPProbeResult{Status: siteAIReady}
	skills := reg.Skills
	var verified *time.Time
	if request.Status == "passed" {
		verified = &now
	} else {
		result.Status, result.Reason, skills = siteAIFailed, &request.Status, []string{}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE site_ai_mcp_registrations SET probe_status=$2 WHERE token_id=$1`, token.ID, request.Status); err != nil {
		return siteAIMCPProbeResult{}, err
	}
	if err = affected(tx.ExecContext(ctx, `UPDATE site_ai_agents SET status=$3,reason=$4,verified_at=$5,verified_skills=$6,updated_at=now()
 WHERE id=$1 AND token_id=$2`, item.AgentID, token.ID, result.Status, result.Reason, verified, pq.Array(skills))); err != nil {
		return siteAIMCPProbeResult{}, err
	}
	outcome := "succeeded"
	if result.Status == siteAIFailed {
		outcome = "failed"
	}
	if err = recordSiteAIAudit(ctx, tx, "agent_token", token.ID, "probe", "agent", *item.AgentID, &token.WorkspaceID, &request.ChallengeID, outcome, result.Reason); err != nil {
		return siteAIMCPProbeResult{}, err
	}
	return result, tx.Commit()
}

func (p *Postgres) heartbeatSiteAIMCP(ctx context.Context, token AgentToken, registration string) (time.Time, error) {
	if !ValidID(registration) {
		return time.Time{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return time.Time{}, err
	}
	defer tx.Rollback()
	if _, err = lockSiteAIMCPToken(ctx, tx, token); err != nil {
		return time.Time{}, err
	}
	expires := time.Now().UTC().Add(siteAIMCPRegistrationLifetime)
	err = affected(tx.ExecContext(ctx, `UPDATE site_ai_mcp_registrations SET expires_at=$3 WHERE token_id=$1 AND id=$2
 AND expires_at>now()`, token.ID, registration, expires))
	if err != nil {
		return time.Time{}, err
	}
	return expires, tx.Commit()
}

func siteAIMCPClaimPolicy(ctx context.Context, tx *sql.Tx, token AgentToken) (dedicated bool, skills pq.StringArray, err error) {
	item, err := readSiteAIToken(ctx, tx, token.ID, false)
	if err != nil || item.Revoked || item.WorkspaceID != token.WorkspaceID {
		return false, nil, ErrNotFound
	}
	if item.Paused {
		return false, nil, errSiteAIClaimPaused
	}
	dedicated = item.AgentID != nil
	registration, err := readSiteAIMCPRegistration(ctx, tx, token.ID)
	if errors.Is(err, ErrNotFound) || err == nil && !time.Now().Before(registration.ExpiresAt) {
		if dedicated {
			return true, nil, errSiteAINotReady
		}
		return false, nil, nil
	}
	if err != nil {
		return false, nil, err
	}
	if dedicated && stringValue(registration.ProbeStatus) != "passed" {
		return true, nil, errSiteAINotReady
	}
	return dedicated, registration.Skills, nil
}

func verifySiteAIMCPClaimBinding(ctx context.Context, tx *sql.Tx, token AgentToken, run, skill string) error {
	dedicated, skills, err := siteAIMCPClaimPolicy(ctx, tx, token)
	if err != nil {
		return err
	}
	if skills != nil && !slices.Contains(skills, skill) {
		return errSiteAINotReady
	}
	binding, err := readSiteAIRunBinding(ctx, tx, token.WorkspaceID, run)
	if err != nil {
		return err
	}
	if dedicated {
		if binding == nil || stringValue(binding.TokenID) != token.ID {
			return ErrNotFound
		}
	} else if binding != nil {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) recordSiteAIMCPActivity(ctx context.Context, tokenID, tool string) error {
	var column string
	switch tool {
	case "task_claim", "task_heartbeat", "task_tool_call", "task_submit":
		column = "claim_at"
	default:
		column = "interactive_at"
	}
	_, err := p.DB.ExecContext(ctx, `UPDATE agent_tokens SET `+column+`=now() WHERE id=$1 AND revoked_at IS NULL`, tokenID)
	return err
}

type siteAIMCPRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func serveSiteAIMCP(w http.ResponseWriter, r *http.Request, p *Postgres, token AgentToken, body []byte) bool {
	var request siteAIMCPRequest
	if json.Unmarshal(body, &request) != nil || !strings.HasPrefix(request.Method, "whippet/agent/") {
		return false
	}
	if !protectedCredentialTransport(r) {
		writeSiteAIError(w, errSiteAITransport)
		return true
	}
	response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
	var result any
	var err error
	if r.Header.Get("MCP-Protocol-Version") == "" || request.JSONRPC != "2.0" || !validSiteAIMCPID(request.ID) || decodeSiteAIJSON(body, &request) != nil {
		err = ErrInvalid
	} else {
		ctx := r.Context()
		switch request.Method {
		case "whippet/agent/register":
			var input siteAIMCPRegisterRequest
			if err = decodeSiteAIJSON(request.Params, &input); err == nil {
				result, err = p.registerSiteAIMCP(ctx, token, input)
			}
		case "whippet/agent/probe":
			var input siteAIMCPProbeRequest
			if err = decodeSiteAIJSON(request.Params, &input); err == nil {
				result, err = p.reportSiteAIMCPProbe(ctx, token, input)
			}
		case "whippet/agent/heartbeat":
			var input struct {
				RegistrationID string `json:"registrationId"`
			}
			if err = decodeSiteAIJSON(request.Params, &input); err == nil {
				var expires time.Time
				expires, err = p.heartbeatSiteAIMCP(ctx, token, input.RegistrationID)
				result = map[string]any{"expiresAt": expires}
			}
		default:
			return false
		}
	}
	if errors.Is(err, ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Agent bearer token required")
		return true
	}
	if err == nil {
		response["result"] = result
	} else {
		code, detail := -32000, "conflict"
		if errors.Is(err, ErrInvalid) {
			code, detail = -32602, "invalid_request"
		} else if err == errSiteAIArchiving || err == errSiteAIArchived || err == errSiteAINotReady {
			detail = err.Error()
		}
		response["error"] = map[string]any{"code": code, "message": "agent control request failed", "data": map[string]string{"code": detail}}
	}
	writeJSON(w, http.StatusOK, response)
	return true
}

func validSiteAIMCPID(raw json.RawMessage) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	switch value.(type) {
	case string, float64:
		return true
	default:
		return false
	}
}
