package server

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/lib/pq"
)

const (
	siteAIManager = "manager"
	siteAIMCP     = "mcp"
)

type siteAICapabilities struct {
	Modes   []string `json:"modes"`
	Engines []string `json:"engines"`
	Skills  []string `json:"skills"`
}

type siteAICapacity struct {
	Total     *int `json:"total"`
	Occupied  int  `json:"occupied"`
	Available *int `json:"available"`
}

type siteAIAttempt struct {
	RunID       string  `json:"runId"`
	AttemptID   string  `json:"attemptId"`
	WorkspaceID string  `json:"workspaceId"`
	AgentID     *string `json:"agentId"`
	Status      string  `json:"status"`
	LeaseID     *string `json:"leaseId"`
}

type siteAIBrowserLease struct {
	SessionID   string    `json:"sessionId"`
	LeaseID     string    `json:"leaseId"`
	WorkspaceID string    `json:"workspaceId"`
	RunID       *string   `json:"runId"`
	State       string    `json:"state"`
	DeadlineAt  time.Time `json:"deadlineAt"`
}

type siteAIResource struct {
	ID             string               `json:"id"`
	Source         string               `json:"source"`
	Name           string               `json:"name"`
	AgentID        *string              `json:"agentId"`
	Revision       int                  `json:"revision"`
	WorkspaceIDs   []string             `json:"workspaceIds"`
	Control        string               `json:"control"`
	Connection     string               `json:"connection"`
	LastActivityAt *time.Time           `json:"lastActivityAt"`
	InteractiveAt  *time.Time           `json:"interactiveAt"`
	ClaimAt        *time.Time           `json:"claimAt"`
	Capabilities   siteAICapabilities   `json:"capabilities"`
	Capacity       siteAICapacity       `json:"capacity"`
	Attempts       []siteAIAttempt      `json:"attempts"`
	BrowserLeases  []siteAIBrowserLease `json:"browserLeases"`
	AllowedActions []string             `json:"allowedActions"`
}

type siteAIManagerState struct {
	ID            string
	Capacity      int
	Revision      int
	Control       string
	WorkspaceIDs  pq.StringArray
	LastHeartbeat *time.Time
}

func siteAIResourceID(value string) (source, id string, ok bool) {
	source, id, ok = strings.Cut(value, ":")
	if !ok {
		return source, id, false
	}
	if source == siteAIManager {
		return source, id, len(id) > 0 && len(id) <= 128
	}
	return source, strings.ToLower(id), source == siteAIMCP && ValidID(id)
}

func readSiteAIManager(ctx context.Context, q queryDB, id string, lock bool) (siteAIManagerState, error) {
	var manager siteAIManagerState
	query := `SELECT id,capacity,dispatch_revision,dispatch_state,dispatch_workspace_ids,last_heartbeat_at FROM managers WHERE id=$1`
	if lock {
		query += ` FOR UPDATE`
	}
	err := q.QueryRowContext(ctx, query, id).Scan(&manager.ID, &manager.Capacity, &manager.Revision, &manager.Control, &manager.WorkspaceIDs, &manager.LastHeartbeat)
	return manager, dbError(err)
}

func (m siteAIManagerState) allows(workspace string) bool {
	return m.Control == "enabled" && (m.WorkspaceIDs == nil || slices.Contains(m.WorkspaceIDs, workspace))
}

func siteAIManagerOccupancy(ctx context.Context, q queryDB, id string) (int, error) {
	var occupied int
	err := q.QueryRowContext(ctx, `SELECT
 (SELECT count(*) FROM runs WHERE manager_id=$1 AND NOT slot_released) +
 (SELECT count(*) FROM agent_browser_leases WHERE manager_id=$1 AND NOT reclaimed) +
 (SELECT count(*) FROM site_ai_provisions WHERE manager_id=$1 AND NOT reclaimed)`, id).Scan(&occupied)
	return occupied, err
}

func (p *Postgres) siteAIResources(ctx context.Context, after string, limit int, connection siteAIConnectionView) (siteAIPage[siteAIResource], error) {
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return siteAIPage[siteAIResource]{}, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT resource_id FROM (
 SELECT 'manager:'||id AS resource_id FROM managers UNION ALL SELECT 'mcp:'||id::text FROM agent_tokens
 ) inventory WHERE resource_id COLLATE "C">$1 ORDER BY resource_id COLLATE "C" LIMIT $2`, after, limit+1)
	if err != nil {
		return siteAIPage[siteAIResource]{}, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return siteAIPage[siteAIResource]{}, err
		}
		ids = append(ids, id)
	}
	if err = rows.Close(); err != nil {
		return siteAIPage[siteAIResource]{}, err
	}
	if err = rows.Err(); err != nil {
		return siteAIPage[siteAIResource]{}, err
	}
	items := make([]siteAIResource, 0, len(ids))
	for _, id := range ids {
		item, err := readSiteAIResource(ctx, tx, id, connection)
		if err != nil {
			return siteAIPage[siteAIResource]{}, err
		}
		items = append(items, item)
	}
	return paginateSiteAI(items, limit, func(item siteAIResource) string { return item.ID }), tx.Commit()
}

func readSiteAIResource(ctx context.Context, q queryDB, resourceID string, connection siteAIConnectionView) (siteAIResource, error) {
	source, id, valid := siteAIResourceID(resourceID)
	if !valid {
		return siteAIResource{}, ErrInvalid
	}
	item := siteAIResource{ID: source + ":" + id, Source: source, Connection: siteAIWaiting,
		Capabilities: siteAICapabilities{Modes: []string{}}, Attempts: []siteAIAttempt{}, BrowserLeases: []siteAIBrowserLease{}, AllowedActions: []string{}}
	if source == siteAIManager {
		if err := loadSiteAIManagerResource(ctx, q, &item, id, connection); err != nil {
			return item, err
		}
	} else if err := loadSiteAITokenResource(ctx, q, &item, id); err != nil {
		return item, err
	}
	if item.LastActivityAt != nil {
		utc := item.LastActivityAt.UTC()
		item.LastActivityAt = &utc
	}
	for _, timestamp := range []*time.Time{item.ClaimAt, item.InteractiveAt} {
		if timestamp != nil {
			*timestamp = timestamp.UTC()
		}
	}
	return item, nil
}

func loadSiteAIManagerResource(ctx context.Context, q queryDB, item *siteAIResource, id string, connection siteAIConnectionView) error {
	m, err := readSiteAIManager(ctx, q, id, false)
	if err != nil {
		return err
	}
	item.Name, item.Revision, item.Control, item.WorkspaceIDs, item.LastActivityAt = m.ID, m.Revision, m.Control, m.WorkspaceIDs, m.LastHeartbeat
	item.Capabilities.Modes = []string{siteAIManaged}
	item.Capacity.Occupied, err = siteAIManagerOccupancy(ctx, q, id)
	if err != nil {
		return err
	}
	if m.LastHeartbeat != nil {
		item.Connection = "offline"
	}
	if connection.ManagerID == id && connection.online(time.Now()) {
		item.Connection = "online"
		if connection.Capabilities != nil {
			item.Capabilities.Engines, item.Capabilities.Skills = connection.Capabilities.Engines, connection.Capabilities.Skills
		}
		item.Capacity.Total = &m.Capacity
		available := connection.available(m.Capacity, item.Capacity.Occupied)
		var anyActive bool
		if err = q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspaces WHERE archive_status='active'
 AND ($1::uuid[] IS NULL OR id=ANY($1)))`, m.WorkspaceIDs).Scan(&anyActive); err != nil {
			return err
		}
		if m.Control != "enabled" || !anyActive {
			available = 0
		}
		item.Capacity.Available = &available
	}
	switch m.Control {
	case "enabled":
		item.AllowedActions = []string{"assign", "pause_dispatch", "drain_remove"}
	case "paused":
		item.AllowedActions = []string{"assign", "resume_dispatch", "drain_remove"}
	case "draining":
		item.AllowedActions = []string{"drain_remove"}
	case "removed":
		item.AllowedActions = []string{"assign"}
	}
	item.Attempts, err = siteAIAttempts(ctx, q, id, true)
	if err == nil {
		item.BrowserLeases, err = siteAILeases(ctx, q, id, true)
	}
	return err
}

func loadSiteAITokenResource(ctx context.Context, q queryDB, item *siteAIResource, id string) error {
	var workspace, state string
	var paused bool
	var revoked, expires *time.Time
	var successor, engine, agentStatus *string
	var skills pq.StringArray
	err := q.QueryRowContext(ctx, `SELECT t.workspace_id,t.name,t.control_revision,t.revoked_at,t.last_used_at,t.interactive_at,t.claim_at,
 t.claim_paused,t.successor_id,w.archive_status,a.id,a.status,g.engine,g.skills,g.expires_at
 FROM agent_tokens t JOIN workspaces w ON w.id=t.workspace_id
 LEFT JOIN site_ai_agents a ON a.id=t.issued_agent_id LEFT JOIN site_ai_mcp_registrations g ON g.token_id=t.id WHERE t.id=$1`, id).
		Scan(&workspace, &item.Name, &item.Revision, &revoked, &item.LastActivityAt, &item.InteractiveAt, &item.ClaimAt,
			&paused, &successor, &state, &item.AgentID, &agentStatus, &engine, &skills, &expires)
	if err != nil {
		return dbError(err)
	}
	item.WorkspaceIDs = []string{workspace}
	item.Attempts, err = siteAIAttempts(ctx, q, id, false)
	if err != nil {
		return err
	}
	item.BrowserLeases, err = siteAILeases(ctx, q, id, false)
	if err != nil {
		return err
	}
	item.Control = "enabled"
	now := time.Now()
	if item.LastActivityAt != nil {
		item.Connection = "offline"
		if now.Sub(*item.LastActivityAt) <= 90*time.Second {
			item.Connection = "online"
		}
	}
	if item.InteractiveAt != nil {
		item.Capabilities.Modes = append(item.Capabilities.Modes, "mcp_interactive")
	}
	if item.ClaimAt != nil {
		item.Capabilities.Modes = append(item.Capabilities.Modes, "mcp_claim")
	}
	if engine != nil {
		item.Capabilities.Engines, item.Capabilities.Skills = []string{*engine}, skills
	}
	item.Capacity.Occupied = len(item.Attempts)
	available := 0
	if expires != nil && now.Before(*expires) && revoked == nil {
		total := 1
		item.Capacity.Total = &total
		if !paused && state == "active" && (agentStatus == nil || *agentStatus == siteAIReady) {
			available = total - item.Capacity.Occupied
		}
		item.Capacity.Available = &available
	}
	if revoked != nil {
		item.Control, item.Connection, item.Capacity.Available = "revoked", "offline", &available
	} else if paused {
		item.Control = "paused"
		item.AllowedActions = append(item.AllowedActions, "resume_claim")
	} else {
		item.AllowedActions = append(item.AllowedActions, "pause_claim")
	}
	if len(item.Attempts) != 0 {
		item.AllowedActions = append(item.AllowedActions, "cancel_run")
	}
	if len(item.BrowserLeases) != 0 {
		item.AllowedActions = append(item.AllowedActions, "close_browser")
	}
	if revoked == nil {
		item.AllowedActions = append(item.AllowedActions, "revoke_access")
	}
	if successor == nil && len(item.Attempts) == 0 && len(item.BrowserLeases) == 0 {
		item.AllowedActions = append(item.AllowedActions, "reissue_access")
	}
	return nil
}

func siteAIAttempts(ctx context.Context, q queryDB, id string, manager bool) ([]siteAIAttempt, error) {
	query := `SELECT r.id,r.attempt_id,r.workspace_id,b.agent_id,r.status,NULL::uuid
 FROM runs r LEFT JOIN site_ai_run_bindings b ON b.run_id=r.id WHERE r.manager_id=$1 AND NOT r.slot_released ORDER BY r.queue_seq`
	if !manager {
		query = `SELECT r.id,r.attempt_id,r.workspace_id,b.agent_id,r.status,c.lease_id FROM external_author_claims c
 JOIN runs r ON r.id=c.run_id AND r.attempt_id=c.attempt_id LEFT JOIN site_ai_run_bindings b ON b.run_id=r.id
 WHERE c.token_id=$1 AND c.state='active' ORDER BY r.queue_seq`
	}
	rows, err := q.QueryContext(ctx, query, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []siteAIAttempt{}
	for rows.Next() {
		var a siteAIAttempt
		if err = rows.Scan(&a.RunID, &a.AttemptID, &a.WorkspaceID, &a.AgentID, &a.Status, &a.LeaseID); err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}

func siteAILeases(ctx context.Context, q queryDB, id string, manager bool) ([]siteAIBrowserLease, error) {
	owner := "token_id"
	if manager {
		owner = "manager_id"
	}
	rows, err := q.QueryContext(ctx, `SELECT session_id,lease_id,workspace_id,author_run_id,state,deadline_at
 FROM agent_browser_leases WHERE `+owner+`=$1 AND NOT reclaimed ORDER BY session_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []siteAIBrowserLease{}
	for rows.Next() {
		var b siteAIBrowserLease
		if err = rows.Scan(&b.SessionID, &b.LeaseID, &b.WorkspaceID, &b.RunID, &b.State, &b.DeadlineAt); err != nil {
			return nil, err
		}
		b.DeadlineAt = b.DeadlineAt.UTC()
		items = append(items, b)
	}
	return items, rows.Err()
}

func (p *Postgres) setSiteAIManager(ctx context.Context, actor platformActor, id, action string, revision int, workspaces []string) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = lockSiteAISuperAdmin(ctx, tx, actor); err != nil {
		return err
	}
	if action == "assign" {
		for _, workspace := range workspaces {
			if err = activeSiteAIWorkspace(ctx, tx, workspace); err != nil {
				return err
			}
		}
	}
	manager, err := readSiteAIManager(ctx, tx, id, true)
	if err != nil {
		return err
	}
	if manager.Revision != revision {
		return errSiteAIStale
	}
	state, assigned := manager.Control, []string(manager.WorkspaceIDs)
	switch action {
	case "assign":
		if state == "draining" {
			return errSiteAIBusy
		}
		if state == "removed" {
			state = "paused"
		}
		assigned = workspaces
	case "resume_dispatch", "pause_dispatch":
		if state == "draining" || state == "removed" {
			return ErrConflict
		}
		state = "enabled"
		if action == "pause_dispatch" {
			state = "paused"
		}
	case "drain_remove":
		occupied, err := siteAIManagerOccupancy(ctx, tx, id)
		if err != nil {
			return err
		}
		state = "draining"
		if occupied == 0 {
			state, assigned = "removed", []string{}
		}
	default:
		return errSiteAIAction
	}
	if state != manager.Control || (assigned == nil) != (manager.WorkspaceIDs == nil) || !slices.Equal(assigned, manager.WorkspaceIDs) {
		if _, err = tx.ExecContext(ctx, `UPDATE managers SET dispatch_state=$2,dispatch_workspace_ids=$3,dispatch_revision=dispatch_revision+1
 WHERE id=$1`, id, state, pq.Array(assigned)); err != nil {
			return err
		}
		if err = recordSiteAIAction(ctx, tx, actor, action, siteAIManager, id, nil, nil); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (p *Postgres) finalizeSiteAIManager(ctx context.Context) error {
	var id string
	if err := p.DB.QueryRowContext(ctx, `SELECT id FROM managers WHERE dispatch_state='draining'`).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	m, err := readSiteAIManager(ctx, tx, id, true)
	if err != nil || m.Control != "draining" {
		return err
	}
	occupied, err := siteAIManagerOccupancy(ctx, tx, id)
	if err != nil || occupied != 0 {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE managers SET dispatch_state='removed',dispatch_workspace_ids='{}',dispatch_revision=dispatch_revision+1
 WHERE id=$1`, id); err != nil {
		return err
	}
	if err = recordSiteAIAudit(ctx, tx, "system", "server", "drain_remove", siteAIManager, id, nil, nil, "succeeded", nil); err != nil {
		return err
	}
	return tx.Commit()
}
