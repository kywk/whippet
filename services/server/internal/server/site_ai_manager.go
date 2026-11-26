package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"time"

	"github.com/lib/pq"
)

type SiteAIManagerCapabilities struct {
	Version        int      `json:"version"`
	Engines        []string `json:"engines"`
	Skills         []string `json:"skills"`
	WorkerRevision string   `json:"workerRevision"`
}

var siteAIWorkerRevision = regexp.MustCompile(`^[a-f0-9]{64}$`)

func ParseSiteAIManagerCapabilities(raw json.RawMessage) (*SiteAIManagerCapabilities, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var caps SiteAIManagerCapabilities
	if err := decodeSiteAIJSON(raw, &caps); err != nil || caps.Version != 1 || !siteAIWorkerRevision.MatchString(caps.WorkerRevision) {
		return nil, ErrInvalid
	}
	if !validSiteAIEnumList(caps.Engines, []string{"builtin", "vercel", "pi"}) || !validSiteAIEnumList(caps.Skills, siteAIPrimarySkills) {
		return nil, ErrInvalid
	}
	return &caps, nil
}

func validSiteAIEnumList(values, allowed []string) bool {
	if len(values) == 0 || len(values) > len(allowed) {
		return false
	}
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if seen[value] || !slices.Contains(allowed, value) {
			return false
		}
		seen[value] = true
	}
	return true
}

type siteAIManagerHeartbeat struct {
	FreeSlots          *int     `json:"freeSlots"`
	ActiveProvisionIDs []string `json:"activeProvisionIds"`
}

func parseSiteAIManagerHeartbeat(raw json.RawMessage, capacity int) (siteAIManagerHeartbeat, error) {
	var update siteAIManagerHeartbeat
	if err := decodeSiteAIJSON(raw, &update); err != nil || update.FreeSlots == nil || *update.FreeSlots < 0 || *update.FreeSlots > capacity ||
		update.ActiveProvisionIDs == nil || len(update.ActiveProvisionIDs) > capacity {
		return update, ErrInvalid
	}
	seen := make(map[string]bool, len(update.ActiveProvisionIDs))
	for _, id := range update.ActiveProvisionIDs {
		if !ValidID(id) || seen[id] {
			return update, ErrInvalid
		}
		seen[id] = true
	}
	return update, nil
}

type siteAIConnectionView struct {
	ManagerID         string
	Epoch             string
	Nonce             string
	Capabilities      *SiteAIManagerCapabilities
	LastHeartbeat     time.Time
	FreeSlots         *int
	ReportedOccupancy int
}

func (p *Postgres) siteAIConnection() siteAIConnectionView {
	if current := p.siteAIConn.Load(); current != nil {
		return *current
	}
	return siteAIConnectionView{}
}

func newSiteAIConnection(manager string, caps *SiteAIManagerCapabilities, secure bool) (siteAIConnectionView, error) {
	view := siteAIConnectionView{ManagerID: manager, Epoch: NewID(), Capabilities: caps}
	if caps != nil && secure {
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return siteAIConnectionView{}, err
		}
		view.Nonce = hex.EncodeToString(nonce[:])
	}
	return view, nil
}

func (v siteAIConnectionView) acknowledgement() any {
	if v.Nonce == "" {
		return struct{}{}
	}
	return map[string]any{"admin": map[string]string{"connectionNonce": v.Nonce}}
}

func (v siteAIConnectionView) online(now time.Time) bool {
	return v.ManagerID != "" && !v.LastHeartbeat.IsZero() && now.Sub(v.LastHeartbeat) <= time.Minute
}

func (v siteAIConnectionView) supports(engine string) bool {
	return v.Nonce != "" && v.Capabilities != nil && slices.Contains(v.Capabilities.Engines, engine)
}

func (v siteAIConnectionView) available(capacity, occupied int) int {
	available := max(0, capacity-occupied)
	if v.FreeSlots != nil {
		// PostgreSQL also counts reservations made after the Manager's heartbeat.
		available = min(available, max(0, *v.FreeSlots-max(0, occupied-v.ReportedOccupancy)))
	}
	return available
}

func siteAIProbeManager(ctx context.Context, q queryDB, connection siteAIConnectionView, workspace, engine string, lock bool) (id, reason string, err error) {
	if !connection.online(time.Now()) || !connection.supports(engine) {
		return "", "manager_unavailable", nil
	}
	manager, err := readSiteAIManager(ctx, q, connection.ManagerID, lock)
	if errors.Is(err, ErrNotFound) || err == nil && !manager.allows(workspace) {
		return "", "manager_unavailable", nil
	}
	if err != nil {
		return "", "", err
	}
	occupied, err := siteAIManagerOccupancy(ctx, q, manager.ID)
	if err != nil {
		return "", "", err
	}
	if connection.available(manager.Capacity, occupied) == 0 {
		return manager.ID, "no_capacity", nil
	}
	return manager.ID, "", nil
}

type siteAIProvision struct {
	ID            string        `json:"operationId"`
	AgentID       string        `json:"agentId"`
	WorkspaceID   string        `json:"workspaceId"`
	SecretVersion int           `json:"secretVersion"`
	Runtime       AuthorRuntime `json:"runtime"`
	DeadlineAt    time.Time     `json:"deadlineAt"`
}

const siteAIProbeTime = 30 * time.Second

func startSiteAIProvision(ctx context.Context, tx *sql.Tx, item siteAIAgentRow, connection siteAIConnectionView) error {
	manager, reason, err := siteAIProbeManager(ctx, tx, connection, item.WorkspaceID, item.Engine, true)
	if err != nil {
		return err
	}
	if reason != "" {
		_, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET status='failed',reason=$2,updated_at=now() WHERE id=$1`, item.ID, reason)
		return err
	}
	if item.Runtime == nil || item.ModelKey == nil || item.ModelKey.Version == nil || !item.ModelKey.Configured {
		return ErrCredentialUnavailable
	}
	op := NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO site_ai_provisions
 (id,agent_id,workspace_id,manager_id,manager_epoch,worker_revision,skills,secret_version,runtime,state,deadline_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`, op, item.ID, item.WorkspaceID, manager, connection.Epoch,
		connection.Capabilities.WorkerRevision, pq.Array(connection.Capabilities.Skills), *item.ModelKey.Version, jsonText(item.Runtime), time.Now().Add(siteAIProbeTime)); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET status='verifying',reason=NULL,probe_id=$2,verified_at=NULL,
 verified_skills='{}',verified_manager_id=NULL,verified_worker_revision=NULL,updated_at=now() WHERE id=$1`, item.ID, op)
	return err
}

func cancelSiteAIProvisions(ctx context.Context, q siteAIExecer, field, id string, cancelSent bool) error {
	// The field is selected by Server call sites, never taken from a request.
	_, err := q.ExecContext(ctx, `WITH cancelled AS (
 UPDATE site_ai_provisions SET
  state=CASE WHEN state='pending' THEN 'done' ELSE 'cancelling' END,
  reclaimed=state='pending',result_status='cancelled',result_code=NULL
 WHERE `+field+`=$1 AND (state='pending' OR ($2 AND state='sent')) RETURNING id,agent_id,state
 ) UPDATE site_ai_agents a SET status=CASE WHEN c.state='done' THEN 'failed' ELSE 'verifying' END,
 reason=CASE WHEN c.state='done' THEN 'verification_required' ELSE 'cleanup_pending' END,updated_at=now()
 FROM cancelled c WHERE a.id=c.agent_id AND a.probe_id=c.id AND a.status='verifying'`, id, cancelSent)
	return err
}

func (p *Postgres) expireSiteAIProvisions(ctx context.Context) error {
	_, err := p.DB.ExecContext(ctx, `WITH locked AS MATERIALIZED (
 SELECT w.id FROM workspaces w WHERE EXISTS(SELECT 1 FROM site_ai_provisions p
 WHERE p.workspace_id=w.id AND p.state IN ('pending','sent') AND p.deadline_at<=now())
 ORDER BY w.id FOR NO KEY UPDATE OF w
 ), expired AS (
 UPDATE site_ai_provisions SET state=CASE WHEN state='pending' THEN 'done' ELSE 'cancelling' END,
 reclaimed=state='pending',result_status=COALESCE(result_status,'timed_out'),
 result_code=CASE WHEN result_status IS NULL THEN 'probe_timed_out' ELSE result_code END
 WHERE workspace_id IN (SELECT id FROM locked) AND state IN ('pending','sent') AND deadline_at<=now() RETURNING id,agent_id,state
 ) UPDATE site_ai_agents a SET status=CASE WHEN e.state='done' THEN 'failed' ELSE 'verifying' END,
 reason=CASE WHEN e.state='done' THEN 'probe_timed_out' ELSE 'cleanup_pending' END,updated_at=now()
 FROM expired e WHERE a.id=e.agent_id AND a.probe_id=e.id AND a.status='verifying'`)
	return err
}

func (p *Postgres) reconcileSiteAIProvisions(ctx context.Context, manager, epoch string) error {
	_, err := p.DB.ExecContext(ctx, `WITH locked AS MATERIALIZED (
 SELECT w.id FROM workspaces w WHERE EXISTS(SELECT 1 FROM site_ai_provisions p
 WHERE p.workspace_id=w.id AND manager_id=$1 AND manager_epoch<>$2 AND p.state IN ('pending','sent'))
 ORDER BY w.id FOR NO KEY UPDATE OF w
 ), stale AS (
 UPDATE site_ai_provisions SET state=CASE WHEN state='pending' THEN 'done' ELSE 'cancelling' END,
 reclaimed=state='pending',result_status=COALESCE(result_status,'cancelled')
 WHERE workspace_id IN (SELECT id FROM locked) AND manager_id=$1 AND manager_epoch<>$2 AND state IN ('pending','sent') RETURNING id,agent_id,state
 ) UPDATE site_ai_agents a SET status=CASE WHEN s.state='done' THEN 'failed' ELSE 'verifying' END,
 reason=CASE WHEN s.state='done' THEN 'heartbeat_timeout' ELSE 'cleanup_pending' END,updated_at=now()
 FROM stale s WHERE a.id=s.agent_id AND a.probe_id=s.id AND a.status='verifying'`, manager, epoch)
	return err
}

type siteAIProvisionCommand struct {
	ID    string
	State string
}

func (p *Postgres) siteAIProvisionCommands(ctx context.Context, manager string) ([]siteAIProvisionCommand, error) {
	rows, err := p.DB.QueryContext(ctx, `SELECT id,state FROM site_ai_provisions WHERE manager_id=$1
 AND state IN ('pending','cancelling') ORDER BY created_at,id`, manager)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pending []siteAIProvisionCommand
	for rows.Next() {
		var c siteAIProvisionCommand
		if err = rows.Scan(&c.ID, &c.State); err != nil {
			return nil, err
		}
		pending = append(pending, c)
	}
	return pending, rows.Err()
}

func (p *Postgres) checkSiteAIProvisionHeartbeat(ctx context.Context, s *Session, ids []string) (int, error) {
	matched := 0
	for _, id := range ids {
		var known bool
		err := p.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM site_ai_provisions WHERE id=$1 AND manager_id=$2 AND NOT reclaimed)`, id, s.managerID).Scan(&known)
		if err != nil {
			return 0, err
		}
		if known {
			matched++
		} else if s.siteAI.Nonce != "" {
			if err := s.peer.Send(NewEnvelope("agent.provision_cancel", s.managerID, "", "", map[string]string{"operationId": id})); err != nil {
				return 0, err
			}
		}
	}
	return matched, nil
}

func (p *Postgres) sendSiteAIProvisions(ctx context.Context, s *Session, live map[string]bool) error {
	if s.siteAI.Nonce == "" || !s.siteAI.online(time.Now()) {
		return nil
	}
	pending, err := p.siteAIProvisionCommands(ctx, s.managerID)
	if err != nil {
		return err
	}
	for _, command := range pending {
		key := "provision:" + command.ID
		live[key] = true
		if time.Since(s.sent[key]) < 5*time.Second {
			continue
		}
		kind := "agent.provision_cancel"
		var payload any = map[string]string{"operationId": command.ID}
		if command.State == "pending" {
			job, err := p.claimSiteAIProvision(ctx, s.siteAI, command.ID)
			if err != nil {
				return err
			}
			if job == nil {
				continue
			}
			kind, payload = "agent.provision", job
		}
		if err := s.peer.Send(NewEnvelope(kind, s.managerID, "", "", payload)); err != nil {
			s.ready = false
			p.siteAIConn.Store(nil)
			_ = s.peer.Close()
			return err
		}
		s.sent[key] = time.Now()
	}
	return nil
}

func (p *Postgres) claimSiteAIProvision(ctx context.Context, conn siteAIConnectionView, id string) (*siteAIProvision, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var workspace string
	if err = tx.QueryRowContext(ctx, `SELECT workspace_id FROM site_ai_provisions WHERE id=$1`, id).Scan(&workspace); err != nil {
		return nil, dbError(err)
	}
	if err = activeSiteAIWorkspace(ctx, tx, workspace); err != nil {
		if errors.Is(err, errSiteAIArchived) || errors.Is(err, errSiteAIArchiving) {
			return nil, nil
		}
		return nil, err
	}
	var out siteAIProvision
	var runtime []byte
	err = tx.QueryRowContext(ctx, `UPDATE site_ai_provisions SET state='sent' WHERE id=$1 AND manager_id=$2 AND manager_epoch=$3
 AND state='pending' AND deadline_at>now() RETURNING id,agent_id,workspace_id,secret_version,runtime,deadline_at`, id, conn.ManagerID, conn.Epoch).
		Scan(&out.ID, &out.AgentID, &out.WorkspaceID, &out.SecretVersion, &runtime, &out.DeadlineAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if json.Unmarshal(runtime, &out.Runtime) != nil || !validAuthorRuntime(&out.Runtime) {
		return nil, ErrInvalid
	}
	out.DeadlineAt = out.DeadlineAt.UTC()
	return &out, tx.Commit()
}

type siteAIProvisionResult struct {
	ID        string  `json:"operationId"`
	Status    string  `json:"status"`
	Code      *string `json:"code"`
	Reclaimed *bool   `json:"reclaimed"`
}

func (r siteAIProvisionResult) valid() bool {
	if !ValidID(r.ID) || r.Reclaimed == nil {
		return false
	}
	switch r.Status {
	case "succeeded", "cancelled":
		return r.Code == nil
	case "timed_out":
		return stringValue(r.Code) == "probe_timed_out"
	case "failed":
		return slices.Contains([]string{"provider_auth_failed", "provider_unavailable", "probe_failed", "key_missing"}, stringValue(r.Code))
	default:
		return false
	}
}

func (p *Postgres) finishSiteAIProvision(ctx context.Context, conn siteAIConnectionView, report siteAIProvisionResult) error {
	if !report.valid() {
		return ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var workspace string
	if err = tx.QueryRowContext(ctx, `SELECT workspace_id FROM site_ai_provisions WHERE id=$1 AND manager_id=$2`, report.ID, conn.ManagerID).Scan(&workspace); err != nil {
		return dbError(err)
	}
	if _, _, err = siteAIWorkspaceStatus(ctx, tx, workspace, true); err != nil {
		return err
	}
	var state, epoch, agent, worker string
	var version int
	var status, code *string
	var deadline time.Time
	var skills pq.StringArray
	if err = tx.QueryRowContext(ctx, `SELECT state,manager_epoch,agent_id,worker_revision,secret_version,result_status,result_code,deadline_at,skills
 FROM site_ai_provisions WHERE id=$1 FOR UPDATE`, report.ID).
		Scan(&state, &epoch, &agent, &worker, &version, &status, &code, &deadline, &skills); err != nil {
		return dbError(err)
	}
	if state == "pending" || (state == "sent" && epoch != conn.Epoch) {
		return ErrConflict
	}
	if status == nil {
		status, code = &report.Status, report.Code
		if time.Now().After(deadline) {
			status, code = stringPointer("timed_out"), stringPointer("probe_timed_out")
		}
	} else if state == "sent" && (*status != report.Status || stringValue(code) != stringValue(report.Code)) {
		return ErrConflict
	}
	if state == "done" {
		return tx.Commit()
	}
	if !*report.Reclaimed {
		if _, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET reason='cleanup_pending',updated_at=now()
 WHERE id=$1 AND probe_id=$2 AND status='verifying'`, agent, report.ID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE site_ai_provisions SET result_status=$2,result_code=$3 WHERE id=$1`, report.ID, status, code)
		if err != nil {
			return err
		}
		return tx.Commit()
	}
	if _, err = tx.ExecContext(ctx, `UPDATE site_ai_provisions SET state='done',reclaimed=true,result_status=$2,result_code=$3 WHERE id=$1`, report.ID, status, code); err != nil {
		return err
	}
	outcome := "failed"
	if *status == "succeeded" {
		outcome = "succeeded"
		_, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET status='ready',reason=NULL,verified_at=now(),verified_skills=$4,
 verified_manager_id=$5,verified_worker_revision=$6,updated_at=now() WHERE id=$1 AND probe_id=$2 AND key_version=$3 AND key_configured`,
			agent, report.ID, version, skills, conn.ManagerID, worker)
	} else {
		if code == nil {
			code = stringPointer("verification_required")
		}
		_, err = tx.ExecContext(ctx, `UPDATE site_ai_agents SET status='failed',reason=$4,updated_at=now()
 WHERE id=$1 AND probe_id=$2 AND key_version=$3 AND key_configured`, agent, report.ID, version, code)
	}
	if err != nil {
		return err
	}
	if err = recordSiteAIAudit(ctx, tx, "manager", conn.ManagerID, "provision", "agent", agent, &workspace, &report.ID, outcome, code); err != nil {
		return err
	}
	return tx.Commit()
}
