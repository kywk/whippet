package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/lib/pq"
)

type siteAIModelKey struct {
	Configured bool `json:"configured"`
	Version    *int `json:"version"`
}

type siteAIAgent struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	Name        string          `json:"name"`
	Revision    int             `json:"revision"`
	Mode        string          `json:"mode"`
	Engine      string          `json:"engine"`
	Provider    string          `json:"provider"`
	Model       string          `json:"model"`
	ProfileID   *string         `json:"profileId"`
	Skills      []string        `json:"skills"`
	Status      string          `json:"status"`
	Reason      *string         `json:"reason"`
	ModelKey    *siteAIModelKey `json:"modelKey"`
	TokenID     *string         `json:"tokenId"`
	ProbeID     *string         `json:"probeId"`
	VerifiedAt  *time.Time      `json:"verifiedAt"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

type siteAIAgentRow struct {
	siteAIAgent
	Runtime             *AuthorRuntime
	WorkspaceState      string
	VerifiedManagerID   *string
	WorkerRevision      *string
	TokenRevoked        bool
	RegistrationExpires *time.Time
	ChallengeExpires    *time.Time
	ProbeStatus         *string
}

const siteAIAgentColumns = `a.id,a.workspace_id,a.name,a.revision,a.mode,a.engine,a.provider,a.model,a.runtime,
 a.key_version,a.key_configured,a.token_id,a.probe_id,a.status,a.reason,a.verified_at,a.verified_skills,
 a.verified_manager_id,a.verified_worker_revision,a.created_at,a.updated_at,w.archive_status,
 t.revoked_at IS NOT NULL,g.expires_at,g.challenge_expires_at,g.probe_status`

const siteAIAgentFrom = ` FROM site_ai_agents a JOIN workspaces w ON w.id=a.workspace_id
 LEFT JOIN agent_tokens t ON t.id=a.token_id LEFT JOIN site_ai_mcp_registrations g ON g.token_id=a.token_id`

func scanSiteAIAgent(row scanner) (siteAIAgentRow, error) {
	var a siteAIAgentRow
	var runtime []byte
	var skills pq.StringArray
	var key siteAIModelKey
	err := row.Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.Revision, &a.Mode, &a.Engine, &a.Provider, &a.Model, &runtime,
		&key.Version, &key.Configured, &a.TokenID, &a.ProbeID, &a.Status, &a.Reason, &a.VerifiedAt, &skills,
		&a.VerifiedManagerID, &a.WorkerRevision, &a.CreatedAt, &a.UpdatedAt, &a.WorkspaceState,
		&a.TokenRevoked, &a.RegistrationExpires, &a.ChallengeExpires, &a.ProbeStatus)
	if err != nil {
		return a, dbError(err)
	}
	if a.Mode == siteAIManaged {
		a.ModelKey = &key
		if json.Unmarshal(runtime, &a.Runtime) != nil || !validAuthorRuntime(a.Runtime) {
			return a, ErrInvalid
		}
		a.ProfileID = &a.Runtime.ProfileID
	}
	a.Skills = append([]string{}, skills...)
	a.CreatedAt, a.UpdatedAt = a.CreatedAt.UTC(), a.UpdatedAt.UTC()
	if a.VerifiedAt != nil {
		*a.VerifiedAt = a.VerifiedAt.UTC()
	}
	return a, nil
}

func readSiteAIAgent(ctx context.Context, q queryDB, id string, lock bool) (siteAIAgentRow, error) {
	query := `SELECT ` + siteAIAgentColumns + siteAIAgentFrom + ` WHERE a.id=$1`
	if lock {
		query += ` FOR UPDATE OF a`
	}
	return scanSiteAIAgent(q.QueryRowContext(ctx, query, id))
}

func presentSiteAIAgent(row siteAIAgentRow, conn siteAIConnectionView, now time.Time) siteAIAgent {
	item := row.siteAIAgent
	switch {
	case row.WorkspaceState != "active":
		item.Status, item.Reason = siteAIUnavailable, stringPointer("workspace_"+row.WorkspaceState)
	case row.TokenRevoked:
		item.Status, item.Reason = siteAIUnavailable, stringPointer("token_revoked")
	case row.Mode == siteAISelfManaged:
		if row.RegistrationExpires != nil && !now.Before(*row.RegistrationExpires) {
			item.Status, item.Reason = siteAIFailed, stringPointer("heartbeat_timeout")
		} else if row.ChallengeExpires != nil && row.ProbeStatus == nil && !now.Before(*row.ChallengeExpires) {
			item.Status, item.Reason = siteAIFailed, stringPointer("probe_timed_out")
		}
	case row.Status == siteAIReady:
		switch {
		case !conn.online(now) || conn.ManagerID != stringValue(row.VerifiedManagerID):
			item.Status, item.Reason = siteAIFailed, stringPointer("heartbeat_timeout")
		case conn.Capabilities == nil || conn.Capabilities.WorkerRevision != stringValue(row.WorkerRevision):
			item.Status, item.Reason = siteAIFailed, stringPointer("worker_changed")
		case !conn.supports(row.Engine):
			item.Status, item.Reason = siteAIFailed, stringPointer("engine_mismatch")
		default:
			item.Skills = []string{}
			for _, skill := range row.Skills {
				if slices.Contains(conn.Capabilities.Skills, skill) {
					item.Skills = append(item.Skills, skill)
				}
			}
		}
	}
	return item
}

func (p *Postgres) listSiteAIAgents(ctx context.Context, workspace, after string, limit int, conn siteAIConnectionView) (siteAIPage[siteAIAgent], error) {
	rows, err := p.DB.QueryContext(ctx, `SELECT `+siteAIAgentColumns+siteAIAgentFrom+`
 WHERE (NULLIF($1,'') IS NULL OR a.workspace_id=NULLIF($1,'')::uuid)
 AND a.id>(COALESCE(NULLIF($2,''),'00000000-0000-0000-0000-000000000000'))::uuid ORDER BY a.id LIMIT $3`, workspace, after, limit+1)
	if err != nil {
		return siteAIPage[siteAIAgent]{}, err
	}
	defer rows.Close()
	items := []siteAIAgent{}
	now := time.Now()
	for rows.Next() {
		item, err := scanSiteAIAgent(rows)
		if err != nil {
			return siteAIPage[siteAIAgent]{}, err
		}
		items = append(items, presentSiteAIAgent(item, conn, now))
	}
	return paginateSiteAI(items, limit, func(item siteAIAgent) string { return item.ID }), rows.Err()
}

type siteAINewAgent struct {
	RequestID   string  `json:"requestId"`
	WorkspaceID string  `json:"workspaceId"`
	Name        string  `json:"name"`
	Mode        string  `json:"mode"`
	Engine      string  `json:"engine"`
	Provider    string  `json:"provider"`
	Model       string  `json:"model"`
	ProfileID   *string `json:"profileId,omitempty"`
	APIKey      *string `json:"apiKey,omitempty"`
}

func (a *siteAINewAgent) normalize() error {
	a.Name = strings.TrimSpace(a.Name)
	a.RequestID, a.WorkspaceID = strings.ToLower(a.RequestID), strings.ToLower(a.WorkspaceID)
	if !ValidID(a.RequestID) || !ValidID(a.WorkspaceID) || !configName(a.Name) || !validSiteAIProvider(a.Provider) || !validSiteAIModel(a.Model) || !validSiteAIEngine(a.Engine) {
		return ErrInvalid
	}
	switch a.Mode {
	case siteAIManaged:
		if a.ProfileID == nil || !moduleSlug.MatchString(*a.ProfileID) || a.APIKey == nil || !validSiteAIKey(*a.APIKey) {
			return ErrInvalid
		}
	case siteAISelfManaged:
		if a.ProfileID != nil || a.APIKey != nil {
			return ErrInvalid
		}
		if a.Engine == "builtin" {
			return errSiteAIUnsupported
		}
	default:
		return errSiteAIUnsupported
	}
	return nil
}

func siteAIFrozenProfile(request siteAINewAgent) (*AuthorRuntime, error) {
	profiles, err := runtimeProfiles()
	if err != nil {
		return nil, err
	}
	profile := profiles[stringValue(request.ProfileID)]
	if profile.ID == "" || profile.Engine != request.Engine || profile.Provider != request.Provider || profile.Model != request.Model {
		return nil, errSiteAIUnsupported
	}
	data := AuthorRuntimeData{SchemaVersion: 1, ProfileID: profile.ID, Engine: profile.Engine, Provider: profile.Provider,
		BaseURL: profile.BaseURL, Model: profile.Model, ReasoningEffort: profile.ReasoningEffort,
		ContextWindowTokens: profile.ContextWindowTokens, ContextInputTokens: profile.ContextInputTokens}
	return &AuthorRuntime{AuthorRuntimeData: data, SHA256: runtimeDigest(data)}, nil
}

type siteAIAgentCreation struct {
	Agent siteAIAgent `json:"agent"`
	Token string      `json:"token,omitempty"`
}

func (p *Postgres) createSiteAIAgent(ctx context.Context, actor platformActor, request siteAINewAgent, digestKey []byte, mcpEnabled bool, conn siteAIConnectionView) (siteAIAgentCreation, bool, error) {
	if err := request.normalize(); err != nil {
		return siteAIAgentCreation{}, false, err
	}
	if request.Mode == siteAIManaged && (p.Secrets == nil || len(digestKey) == 0) {
		return siteAIAgentCreation{}, false, ErrSecretsUnavailable
	}
	if request.Mode == siteAISelfManaged {
		digestKey = nil
	}
	digest, err := siteAIRequestDigest(request, digestKey)
	if err != nil {
		return siteAIAgentCreation{}, false, err
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return siteAIAgentCreation{}, false, err
	}
	defer tx.Rollback()
	if err = lockSiteAISuperAdmin(ctx, tx, actor); err != nil {
		return siteAIAgentCreation{}, false, err
	}
	prior, err := lockSiteAIRequest(ctx, tx, actor, "create_agent", request.RequestID, digest)
	if err != nil {
		return siteAIAgentCreation{}, false, err
	}
	if prior != "" {
		item, err := readSiteAIAgent(ctx, tx, prior, false)
		return siteAIAgentCreation{Agent: presentSiteAIAgent(item, conn, time.Now())}, false, err
	}
	if err = activeSiteAIWorkspace(ctx, tx, request.WorkspaceID); err != nil {
		return siteAIAgentCreation{}, false, err
	}
	agentID := NewID()
	var token, tokenID string
	if request.Mode == siteAIManaged {
		runtime, err := siteAIFrozenProfile(request)
		if err != nil {
			return siteAIAgentCreation{}, false, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO site_ai_agents
 (id,workspace_id,name,mode,engine,provider,model,runtime,key_version,key_configured,status)
 VALUES($1,$2,$3,'managed',$4,$5,$6,$7,1,true,'verifying')`, agentID, request.WorkspaceID, request.Name,
			request.Engine, request.Provider, request.Model, jsonText(runtime)); err != nil {
			return siteAIAgentCreation{}, false, err
		}
		if err = p.storeSiteAIKey(ctx, tx, request.WorkspaceID, agentID, 1, *request.APIKey); err != nil {
			return siteAIAgentCreation{}, false, err
		}
		item, err := readSiteAIAgent(ctx, tx, agentID, false)
		if err != nil {
			return siteAIAgentCreation{}, false, err
		}
		if err = startSiteAIProvision(ctx, tx, item, conn); err != nil {
			return siteAIAgentCreation{}, false, err
		}
	} else {
		if !mcpEnabled {
			return siteAIAgentCreation{}, false, errSiteAIDisabled
		}
		tokenID, token, err = insertSiteAIToken(ctx, tx, request.WorkspaceID, "Agent "+agentID)
		if err != nil {
			return siteAIAgentCreation{}, false, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO site_ai_agents(id,workspace_id,name,mode,engine,provider,model,token_id,status)
 VALUES($1,$2,$3,'self_managed',$4,$5,$6,$7,'waiting_connection')`, agentID, request.WorkspaceID, request.Name,
			request.Engine, request.Provider, request.Model, tokenID); err != nil {
			return siteAIAgentCreation{}, false, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE agent_tokens SET issued_agent_id=$2 WHERE id=$1`, tokenID, agentID); err != nil {
			return siteAIAgentCreation{}, false, err
		}
	}
	if err = saveSiteAIRequest(ctx, tx, actor, "create_agent", request.RequestID, digest, agentID); err != nil {
		return siteAIAgentCreation{}, false, err
	}
	if err = recordSiteAIAction(ctx, tx, actor, "create_agent", "agent", agentID, &request.WorkspaceID, &request.RequestID); err != nil {
		return siteAIAgentCreation{}, false, err
	}
	item, err := readSiteAIAgent(ctx, tx, agentID, false)
	if err != nil {
		return siteAIAgentCreation{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return siteAIAgentCreation{}, false, err
	}
	return siteAIAgentCreation{Agent: presentSiteAIAgent(item, conn, time.Now()), Token: token}, true, nil
}

func insertSiteAIToken(ctx context.Context, q siteAIExecer, workspace, name string) (id, secret string, err error) {
	var raw [32]byte
	if _, err = rand.Read(raw[:]); err != nil {
		return "", "", err
	}
	defer clear(raw[:])
	secret = base64.RawURLEncoding.EncodeToString(raw[:])
	digest := sha256.Sum256([]byte(secret))
	id = NewID()
	_, err = q.ExecContext(ctx, `INSERT INTO agent_tokens(id,workspace_id,name,token_hash) VALUES($1,$2,$3,$4)`, id, workspace, name, digest[:])
	return id, secret, err
}

func (p *Postgres) retrySiteAIAgent(ctx context.Context, actor platformActor, id string, revision int, conn siteAIConnectionView) (siteAIAgent, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return siteAIAgent{}, err
	}
	defer tx.Rollback()
	if err = lockSiteAISuperAdmin(ctx, tx, actor); err != nil {
		return siteAIAgent{}, err
	}
	item, err := lockSiteAIAgentWorkspace(ctx, tx, id, true)
	if err != nil {
		return siteAIAgent{}, err
	}
	if item.Revision != revision {
		return siteAIAgent{}, errSiteAIStale
	}
	var busy bool
	if item.Mode == siteAIManaged {
		if item.ModelKey == nil || !item.ModelKey.Configured {
			return siteAIAgent{}, ErrCredentialUnavailable
		}
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM site_ai_provisions WHERE agent_id=$1 AND NOT reclaimed)`, id).Scan(&busy); err != nil {
			return siteAIAgent{}, err
		}
		if busy {
			return siteAIAgent{}, errSiteAIBusy
		}
		err = startSiteAIProvision(ctx, tx, item, conn)
	} else {
		if item.TokenRevoked || item.TokenID == nil {
			return siteAIAgent{}, ErrCredentialUnavailable
		}
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM external_author_claims WHERE token_id=$1 AND state='active')`, item.TokenID).Scan(&busy); err != nil {
			return siteAIAgent{}, err
		}
		if busy {
			return siteAIAgent{}, errSiteAIBusy
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM site_ai_mcp_registrations WHERE token_id=$1`, item.TokenID); err != nil {
			return siteAIAgent{}, err
		}
		_, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET status='waiting_connection',reason=NULL,probe_id=NULL,
 verified_at=NULL,verified_skills='{}' WHERE id=$1`, id)
	}
	if err != nil {
		return siteAIAgent{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET revision=revision+1,updated_at=now() WHERE id=$1`, id); err != nil {
		return siteAIAgent{}, err
	}
	if err = recordSiteAIAction(ctx, tx, actor, "retry_agent", "agent", id, &item.WorkspaceID, nil); err != nil {
		return siteAIAgent{}, err
	}
	return commitSiteAIAgent(ctx, tx, id, conn)
}

func lockSiteAIAgentWorkspace(ctx context.Context, tx *sql.Tx, id string, requireActive bool) (siteAIAgentRow, error) {
	var workspace string
	if err := tx.QueryRowContext(ctx, `SELECT workspace_id FROM site_ai_agents WHERE id=$1`, id).Scan(&workspace); err != nil {
		return siteAIAgentRow{}, dbError(err)
	}
	state, _, err := siteAIWorkspaceStatus(ctx, tx, workspace, true)
	if err != nil {
		return siteAIAgentRow{}, err
	}
	if requireActive {
		if err = siteAIWorkspaceError(state); err != nil {
			return siteAIAgentRow{}, err
		}
	}
	return readSiteAIAgent(ctx, tx, id, true)
}

func commitSiteAIAgent(ctx context.Context, tx *sql.Tx, id string, conn siteAIConnectionView) (siteAIAgent, error) {
	updated, err := readSiteAIAgent(ctx, tx, id, false)
	if err != nil {
		return siteAIAgent{}, err
	}
	return presentSiteAIAgent(updated, conn, time.Now()), tx.Commit()
}

func siteAIRequestKey(master []byte) [sha256.Size]byte {
	mac := hmac.New(sha256.New, master)
	_, _ = mac.Write([]byte("whippet-admin-idempotency-v1"))
	var key [sha256.Size]byte
	copy(key[:], mac.Sum(nil))
	return key
}

func (p *Postgres) siteAIOptions(ctx context.Context, workspace string, mcpEnabled bool, conn siteAIConnectionView) (siteAIAgentOptions, error) {
	options := siteAIAgentOptions{Managed: []siteAIManagedOption{}, SelfManaged: []siteAISelfOption{}}
	state, _, err := siteAIWorkspaceStatus(ctx, p.DB, workspace, false)
	if err != nil {
		return options, err
	}
	profiles, err := runtimeProfiles()
	if err != nil {
		return options, err
	}
	for _, id := range sortedRuntimeProfileIDs(profiles) {
		profile := profiles[id]
		if profile.Provider == "" || profile.Model == "" {
			continue
		}
		item := siteAIManagedOption{ProfileID: id, Engine: profile.Engine, Provider: profile.Provider, Model: profile.Model, ManagerIDs: []string{}}
		if state != "active" {
			item.Reason = stringPointer("workspace_" + state)
		} else {
			manager, reason, err := siteAIProbeManager(ctx, p.DB, conn, workspace, profile.Engine, false)
			if err != nil {
				return options, err
			}
			if manager != "" {
				item.ManagerIDs = append(item.ManagerIDs, manager)
			}
			if reason != "" {
				item.Reason = &reason
			}
		}
		options.Managed = append(options.Managed, item)
	}
	if mcpEnabled {
		for _, engine := range []string{"vercel", "pi"} {
			options.SelfManaged = append(options.SelfManaged, siteAISelfOption{Engine: engine,
				Providers: []string{"opencode", "openai-responses"}, Skills: []string{"test-author"}})
		}
	}
	return options, nil
}

type siteAIAgentOptions struct {
	Managed     []siteAIManagedOption `json:"managed"`
	SelfManaged []siteAISelfOption    `json:"selfManaged"`
}

type siteAIManagedOption struct {
	ProfileID  string   `json:"profileId"`
	Engine     string   `json:"engine"`
	Provider   string   `json:"provider"`
	Model      string   `json:"model"`
	ManagerIDs []string `json:"managerIds"`
	Reason     *string  `json:"reason"`
}

type siteAISelfOption struct {
	Engine    string   `json:"engine"`
	Providers []string `json:"providers"`
	Skills    []string `json:"skills"`
}

type siteAIRouting struct {
	WorkspaceID string            `json:"workspaceId"`
	Revision    int               `json:"revision"`
	Agents      map[string]string `json:"agents"`
}

func readSiteAIRouting(ctx context.Context, q queryDB, workspace string) (siteAIRouting, error) {
	result := siteAIRouting{WorkspaceID: workspace, Agents: map[string]string{}}
	var agents []byte
	err := q.QueryRowContext(ctx, `SELECT agent_routing_revision,COALESCE((
 SELECT jsonb_object_agg(skill_id,agent_id) FROM site_ai_agent_routes WHERE workspace_id=w.id),'{}'::jsonb)
 FROM workspaces w WHERE id=$1`, workspace).Scan(&result.Revision, &agents)
	if err == nil {
		err = json.Unmarshal(agents, &result.Agents)
	}
	return result, dbError(err)
}

func (p *Postgres) setSiteAIRouting(ctx context.Context, actor platformActor, workspace, skill string, agent *string, revision int, conn siteAIConnectionView) (siteAIRouting, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return siteAIRouting{}, err
	}
	defer tx.Rollback()
	if err = lockSiteAISuperAdmin(ctx, tx, actor); err != nil {
		return siteAIRouting{}, err
	}
	if err = activeSiteAIWorkspace(ctx, tx, workspace); err != nil {
		return siteAIRouting{}, err
	}
	current, err := readSiteAIRouting(ctx, tx, workspace)
	if err != nil {
		return siteAIRouting{}, err
	}
	if revision != current.Revision {
		return siteAIRouting{}, errSiteAIStale
	}
	if agent != nil {
		item, err := readSiteAIAgent(ctx, tx, *agent, false)
		if err != nil {
			return siteAIRouting{}, err
		}
		if item.WorkspaceID != workspace {
			return siteAIRouting{}, ErrNotFound
		}
		presented := presentSiteAIAgent(item, conn, time.Now())
		if presented.Status != siteAIReady {
			return siteAIRouting{}, errSiteAINotReady
		}
		if !slices.Contains(presented.Skills, skill) {
			return siteAIRouting{}, errSiteAIUnsupported
		}
	}
	if current.Agents[skill] == stringValue(agent) {
		return current, tx.Commit()
	}
	if agent != nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO site_ai_agent_routes(workspace_id,skill_id,agent_id) VALUES($1,$2,$3)
 ON CONFLICT(workspace_id,skill_id) DO UPDATE SET agent_id=EXCLUDED.agent_id`, workspace, skill, agent)
		current.Agents[skill] = *agent
	} else {
		_, err = tx.ExecContext(ctx, `DELETE FROM site_ai_agent_routes WHERE workspace_id=$1 AND skill_id=$2`, workspace, skill)
		delete(current.Agents, skill)
	}
	if err != nil {
		return siteAIRouting{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspaces SET agent_routing_revision=agent_routing_revision+1 WHERE id=$1`, workspace); err != nil {
		return siteAIRouting{}, err
	}
	if err = recordSiteAIAction(ctx, tx, actor, "set_agent_routing", "workspace", workspace, &workspace, nil); err != nil {
		return siteAIRouting{}, err
	}
	current.Revision++
	return current, tx.Commit()
}

func siteAIAgentForSkill(ctx context.Context, q queryDB, workspace, skill string) (*siteAIAgentRow, error) {
	var agent string
	err := q.QueryRowContext(ctx, `SELECT agent_id FROM site_ai_agent_routes WHERE workspace_id=$1 AND skill_id=$2`, workspace, skill).Scan(&agent)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item, err := readSiteAIAgent(ctx, q, agent, false)
	return &item, err
}
