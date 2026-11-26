package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type workspaceArchiveStatus string

const (
	workspaceActive    workspaceArchiveStatus = "active"
	workspaceArchiving workspaceArchiveStatus = "archiving"
	workspaceArchived  workspaceArchiveStatus = "archived"
)

var (
	errWorkspaceArchiving = fmt.Errorf("%w: 工作區封存中，暫停接受新工作。", ErrConflict)
	errWorkspaceArchived  = fmt.Errorf("%w: 工作區已封存。", ErrConflict)
	errManagementRevision = fmt.Errorf("%w: 工作區管理資料已更新，請重新載入。", ErrConflict)
)

func (s workspaceArchiveStatus) workError() error {
	switch s {
	case workspaceArchiving:
		return errWorkspaceArchiving
	case workspaceArchived:
		return errWorkspaceArchived
	default:
		return nil
	}
}

func workspaceErrorCode(err error) string {
	switch {
	case errors.Is(err, errWorkspaceArchiving):
		return "workspace_archiving"
	case errors.Is(err, errWorkspaceArchived):
		return "workspace_archived"
	default:
		return ""
	}
}

type workspaceManagement struct {
	State            workspaceArchiveStatus `json:"state"`
	Revision         int                    `json:"revision"`
	ArchiveMode      *string                `json:"archiveMode"`
	ArchiveStartedAt *time.Time             `json:"archiveStartedAt"`
	ArchivedAt       *time.Time             `json:"archivedAt"`
}

const workspaceManagementColumns = `w.archive_status,w.management_revision,w.archive_mode,w.archive_started_at,w.archived_at`

func (m *workspaceManagement) scanFields() []any {
	return []any{&m.State, &m.Revision, &m.ArchiveMode, &m.ArchiveStartedAt, &m.ArchivedAt}
}

func (m *workspaceManagement) setUTC() {
	if m.ArchiveStartedAt != nil {
		at := m.ArchiveStartedAt.UTC()
		m.ArchiveStartedAt = &at
	}
	if m.ArchivedAt != nil {
		at := m.ArchivedAt.UTC()
		m.ArchivedAt = &at
	}
}

type workspaceSummary struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	Lifecycle   string               `json:"lifecycle"`
	Management  workspaceManagement  `json:"management"`
	Permissions workspacePermissions `json:"permissions"`
}

type workspaceArchiveImpact struct {
	QueuedRuns         int `json:"queuedRuns"`
	ActiveRuns         int `json:"activeRuns"`
	ExternalClaims     int `json:"externalClaims"`
	BrowserLeases      int `json:"browserLeases"`
	UnreleasedRunSlots int `json:"unreleasedRunSlots"`
	ProvisionJobs      int `json:"provisionJobs"`
}

type managedWorkspace struct {
	Workspace workspaceSummary       `json:"workspace"`
	Impact    workspaceArchiveImpact `json:"impact"`
}

const workspaceSummaryColumns = `w.id,COALESCE(w.management_name,w.name),w.lifecycle,` + workspaceManagementColumns

func scanWorkspaceSummary(row scanner, role siteRole, extra ...any) (workspaceSummary, error) {
	var item workspaceSummary
	fields := []any{&item.ID, &item.Name, &item.Lifecycle}
	fields = append(fields, item.Management.scanFields()...)
	err := row.Scan(append(fields, extra...)...)
	item.Management.setUTC()
	item.Permissions = permissionsForWorkspace(role, noMemberRole)
	return item, dbError(err)
}

func (p *Postgres) managedWorkspaceList(ctx context.Context, role siteRole, state, after string, limit int) ([]workspaceSummary, *string, error) {
	var cursor *string
	if after != "" {
		cursor = &after
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT `+workspaceSummaryColumns+` FROM workspaces w
 WHERE ($1='all' OR w.archive_status=$1) AND ($2::uuid IS NULL OR w.id>$2)
 ORDER BY w.id LIMIT $3`, state, cursor, limit+1)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := []workspaceSummary{}
	for rows.Next() {
		item, err := scanWorkspaceSummary(rows, role)
		if err != nil {
			return nil, nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if len(items) > limit {
		return items[:limit], &items[limit-1].ID, nil
	}
	return items, nil, nil
}

const workspaceBusyRun = `status IN ('dispatched','running','collecting','cancelling')`
const workspaceUnfinishedRun = `(status IN ('queued','dispatched','running','collecting','cancelling') OR NOT slot_released)`

func readManagedWorkspace(ctx context.Context, q queryDB, id string, role siteRole) (managedWorkspace, error) {
	var item managedWorkspace
	impact := &item.Impact
	row := q.QueryRowContext(ctx, `SELECT `+workspaceSummaryColumns+`,r.queued,r.active,
 (SELECT count(*) FROM external_author_claims WHERE workspace_id=w.id AND state='active'),
 (SELECT count(*) FROM agent_browser_leases WHERE workspace_id=w.id AND NOT reclaimed),r.unreleased
 FROM workspaces w CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE status='queued') AS queued,
         count(*) FILTER (WHERE `+workspaceBusyRun+`) AS active,
         count(*) FILTER (WHERE manager_id IS NOT NULL AND NOT slot_released) AS unreleased
  FROM runs WHERE workspace_id=w.id AND `+workspaceUnfinishedRun+`
 ) r WHERE w.id=$1`, id)
	// Provisioning is introduced in ADM-3. The field is part of the ADM-1 response.
	var err error
	item.Workspace, err = scanWorkspaceSummary(row, role, &impact.QueuedRuns, &impact.ActiveRuns, &impact.ExternalClaims, &impact.BrowserLeases, &impact.UnreleasedRunSlots)
	return item, err
}

func lockWorkspaceWorkStatus(ctx context.Context, tx *sql.Tx, id string) (workspaceArchiveStatus, error) {
	var status workspaceArchiveStatus
	err := tx.QueryRowContext(ctx, `SELECT archive_status FROM workspaces WHERE id=$1 FOR SHARE`, id).Scan(&status)
	return status, dbError(err)
}

func requireActiveWorkspace(ctx context.Context, tx *sql.Tx, id string) error {
	status, err := lockWorkspaceWorkStatus(ctx, tx, id)
	if err != nil {
		return err
	}
	return status.workError()
}

func lockManagedWorkspace(ctx context.Context, tx *sql.Tx, actor platformActor, id string, revision int) (workspaceSummary, siteRole, error) {
	if revision < 1 {
		return workspaceSummary{}, noSiteRole, ErrInvalid
	}
	role, err := lockActorSiteRole(ctx, tx, actor)
	if err != nil {
		return workspaceSummary{}, role, err
	}
	if !role.admin() {
		return workspaceSummary{}, role, errForbidden
	}
	item, err := scanWorkspaceSummary(tx.QueryRowContext(ctx, `SELECT `+workspaceSummaryColumns+` FROM workspaces w WHERE w.id=$1 FOR NO KEY UPDATE OF w`, id), role)
	if err == nil && item.Management.Revision != revision {
		err = errManagementRevision
	}
	return item, role, err
}

func (p *Postgres) renameManagedWorkspace(ctx context.Context, actor platformActor, id string, revision int, name string) (managedWorkspace, error) {
	name = strings.TrimSpace(name)
	if !configName(name) {
		return managedWorkspace{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return managedWorkspace{}, err
	}
	defer tx.Rollback()
	current, role, err := lockManagedWorkspace(ctx, tx, actor, id, revision)
	if err != nil {
		return managedWorkspace{}, err
	}
	if current.Name != name {
		if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET management_name=$2,management_revision=management_revision+1 WHERE id=$1`, id, name); err != nil {
			return managedWorkspace{}, err
		}
		if err := platformAudit(actor, "rename_workspace", "workspace", id, &id).record(ctx, tx, "succeeded", nil); err != nil {
			return managedWorkspace{}, err
		}
	}
	return commitManagedWorkspace(ctx, tx, id, role)
}

func (p *Postgres) archiveWorkspace(ctx context.Context, actor platformActor, id string, revision int, mode string) (managedWorkspace, error) {
	if mode != "drain" && mode != "cancel" {
		return managedWorkspace{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return managedWorkspace{}, err
	}
	defer tx.Rollback()
	current, role, err := lockManagedWorkspace(ctx, tx, actor, id, revision)
	if err != nil {
		return managedWorkspace{}, err
	}
	management := current.Management
	if stringValue(management.ArchiveMode) == mode {
		return commitManagedWorkspace(ctx, tx, id, role)
	}
	if management.State == workspaceArchived || (management.State == workspaceArchiving && mode == "drain") {
		return managedWorkspace{}, ErrConflict
	}

	if err := cancelWorkspaceWork(ctx, tx, id, mode == "cancel"); err != nil {
		return managedWorkspace{}, err
	}
	item, err := readManagedWorkspace(ctx, tx, id, role)
	if err != nil {
		return managedWorkspace{}, err
	}
	next := workspaceArchiving
	if item.Impact == (workspaceArchiveImpact{}) {
		next = workspaceArchived
		if err := stopWorkspaceFollowups(ctx, tx, id); err != nil {
			return managedWorkspace{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET archive_status=$2,archive_mode=$3,
 archive_started_at=COALESCE(archive_started_at,now()),archived_at=CASE WHEN $2='archived' THEN now() END,
 management_revision=management_revision+1 WHERE id=$1`, id, next, mode); err != nil {
		return managedWorkspace{}, err
	}
	outcome := "accepted"
	if next == workspaceArchived {
		outcome = "succeeded"
	}
	if err := platformAudit(actor, "archive_workspace", "workspace", id, &id).record(ctx, tx, outcome, nil); err != nil {
		return managedWorkspace{}, err
	}
	return commitManagedWorkspace(ctx, tx, id, role)
}

func cancelWorkspaceWork(ctx context.Context, tx *sql.Tx, id string, cancelActive bool) error {
	if cancelActive {
		// External tools, heartbeats and submissions lock the claim before the Run.
		if _, err := tx.ExecContext(ctx, `UPDATE external_author_claims SET state='cancelled' WHERE workspace_id=$1 AND state='active'`, id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET
 status=CASE WHEN status='queued' OR author_engine='external' THEN 'cancelled' ELSE 'cancelling' END,
 finished_at=CASE WHEN status='queued' OR author_engine='external' THEN now() ELSE finished_at END,
 error='workspace_archiving'
 WHERE workspace_id=$1 AND (status='queued' OR ($2 AND `+workspaceBusyRun+`))`, id, cancelActive); err != nil {
		return err
	}
	if cancelActive {
		_, err := tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing'
 WHERE workspace_id=$1 AND NOT reclaimed AND state IN ('opening','ready')`, id)
		return err
	}
	return nil
}

func (p *Postgres) restoreWorkspace(ctx context.Context, actor platformActor, id string, revision int) (managedWorkspace, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return managedWorkspace{}, err
	}
	defer tx.Rollback()
	current, role, err := lockManagedWorkspace(ctx, tx, actor, id, revision)
	if err != nil {
		return managedWorkspace{}, err
	}
	switch current.Management.State {
	case workspaceArchiving:
		return managedWorkspace{}, errWorkspaceArchiving
	case workspaceArchived:
		if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET archive_status='active',archive_mode=NULL,archive_started_at=NULL,archived_at=NULL,
 management_revision=management_revision+1 WHERE id=$1`, id); err != nil {
			return managedWorkspace{}, err
		}
		if err := platformAudit(actor, "restore_workspace", "workspace", id, &id).record(ctx, tx, "succeeded", nil); err != nil {
			return managedWorkspace{}, err
		}
	}
	return commitManagedWorkspace(ctx, tx, id, role)
}

func commitManagedWorkspace(ctx context.Context, tx *sql.Tx, id string, role siteRole) (managedWorkspace, error) {
	item, err := readManagedWorkspace(ctx, tx, id, role)
	if err != nil {
		return item, err
	}
	return item, tx.Commit()
}

func (p *Postgres) finalizeWorkspaceArchives(ctx context.Context) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id FROM workspaces WHERE archive_status='archiving' ORDER BY id FOR NO KEY UPDATE SKIP LOCKED`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		// Read pending work after acquiring the lock, including a reservation
		// that committed before the archive transaction.
		item, err := readManagedWorkspace(ctx, tx, id, noSiteRole)
		if err != nil {
			return err
		}
		if item.Impact != (workspaceArchiveImpact{}) {
			continue
		}
		if err := stopWorkspaceFollowups(ctx, tx, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET archive_status='archived',archived_at=now(),
 management_revision=management_revision+1 WHERE id=$1`, id); err != nil {
			return err
		}
		if err := platformAudit(platformActor{}, "archive_workspace", "workspace", id, &id).record(ctx, tx, "succeeded", nil); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Deferred validation and Plan progression must never resume simply because a
// Workspace was restored before the next scheduler tick.
func stopWorkspaceFollowups(ctx context.Context, tx *sql.Tx, id string) error {
	if _, err := tx.ExecContext(ctx, `WITH skipped AS (
 UPDATE module_validation_requests q SET resolved=true FROM runs r
 WHERE r.id=q.source_run_id AND r.workspace_id=$1 AND NOT q.resolved
 RETURNING r.id,r.attempt_id
 )
 INSERT INTO run_events(run_id,event_id,attempt_id,kind,message)
 SELECT id,$2,attempt_id,'log','workspace_archiving' FROM skipped WHERE attempt_id IS NOT NULL ON CONFLICT DO NOTHING`, id, archiveProgressEventID); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `UPDATE plans p SET status='stopped',revision=p.revision+1,error='workspace_archiving'
 FROM tests t WHERE p.test_id=t.id AND t.workspace_id=$1 AND p.status='running' RETURNING p.stages`, id)
	if err != nil {
		return err
	}
	var plans [][]byte
	for rows.Next() {
		var stages []byte
		if err := rows.Scan(&stages); err != nil {
			rows.Close()
			return err
		}
		plans = append(plans, stages)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, stages := range plans {
		if err := recordPlanArchiveProgress(ctx, tx, string(stages)); err != nil {
			return err
		}
	}
	return nil
}

func recordArchiveProgress(ctx context.Context, tx *sql.Tx, runID string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO run_events(run_id,event_id,attempt_id,kind,message)
 SELECT id,$2,attempt_id,'log','workspace_archiving' FROM runs WHERE id=$1 AND attempt_id IS NOT NULL ON CONFLICT DO NOTHING`, runID, archiveProgressEventID)
	return err
}

func recordPlanArchiveProgress(ctx context.Context, tx *sql.Tx, stages string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO run_events(run_id,event_id,attempt_id,kind,message)
 SELECT r.id,$2,r.attempt_id,'log','workspace_archiving' FROM jsonb_array_elements($1::jsonb) s
 JOIN runs r ON r.id IN ((s->>'authorRunId')::uuid,(s->>'validationRunId')::uuid)
 WHERE r.status='succeeded' AND r.attempt_id IS NOT NULL ORDER BY r.queue_seq DESC LIMIT 1 ON CONFLICT DO NOTHING`, stages, archiveProgressEventID)
	return err
}
