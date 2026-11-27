package server

import (
	"context"
	"database/sql"

	"github.com/lib/pq"
)

type workspaceListItem struct {
	workspace  Workspace
	proposalID *string
	memberRole memberRole
}

func (p *Postgres) Workspaces(ctx context.Context) ([]Workspace, error) {
	return p.listWorkspaces(ctx, nil)
}

func (p *Postgres) memberWorkspaces(ctx context.Context, userID string) ([]Workspace, error) {
	return p.listWorkspaces(ctx, &userID)
}

func (p *Postgres) listWorkspaces(ctx context.Context, userID *string) ([]Workspace, error) {
	// Membership, settings, and the referenced rows must come from one snapshot.
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	items, err := listWorkspaceCores(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if err := loadWorkspaceListProposals(ctx, tx, items); err != nil {
		return nil, err
	}
	if err := loadWorkspaceListRoles(ctx, tx, items); err != nil {
		return nil, err
	}
	for i := range items {
		w := &items[i].workspace
		if err := populateWorkspaceLogin(ctx, tx, w); err != nil {
			return nil, err
		}
		if w.CurrentProposal != nil {
			if err := populateProposalLogin(ctx, tx, w.CurrentProposal); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	workspaces := make([]Workspace, 0, len(items))
	for _, item := range items {
		workspace := item.workspace
		setWorkspaceAvailability(&workspace, p.Secrets != nil, p.CredentialTLS)
		if userID != nil {
			workspace = presentWorkspace(workspace, permissionsForWorkspace(noSiteRole, item.memberRole))
		}
		workspaces = append(workspaces, workspace)
	}
	return workspaces, nil
}

func listWorkspaceCores(ctx context.Context, tx *sql.Tx, userID *string) ([]workspaceListItem, error) {
	stmt := `SELECT ` + workspaceCoreColumns + ` FROM workspaces w WHERE w.archive_status<>'archived' ORDER BY w.id`
	var args []any
	if userID != nil {
		stmt = `SELECT ` + workspaceCoreColumns + `,m.role FROM workspaces w
 JOIN workspace_memberships m ON m.workspace_id=w.id AND m.user_id=$1 WHERE w.archive_status<>'archived' ORDER BY w.id`
		args = append(args, *userID)
	}
	rows, err := tx.QueryContext(ctx, stmt, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []workspaceListItem
	for rows.Next() {
		var item workspaceListItem
		var extra []any
		if userID != nil {
			extra = append(extra, &item.memberRole)
		}
		item.workspace, item.proposalID, err = scanWorkspaceCore(rows, extra...)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadWorkspaceListProposals(ctx context.Context, tx *sql.Tx, items []workspaceListItem) error {
	var ids []string
	byProposal := map[string]*Workspace{}
	for i := range items {
		if id := items[i].proposalID; id != nil {
			if _, exists := byProposal[*id]; exists {
				return ErrNotFound
			}
			ids = append(ids, *id)
			byProposal[*id] = &items[i].workspace
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+workspaceProposalColumns+` FROM workspace_proposals WHERE id=ANY($1::uuid[])`, pq.Array(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		proposal, err := scanWorkspaceProposal(rows)
		if err != nil {
			return err
		}
		workspace := byProposal[proposal.ID]
		if workspace == nil || workspace.ID != proposal.WorkspaceID {
			return ErrNotFound
		}
		workspace.CurrentProposal = &proposal
		delete(byProposal, proposal.ID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(byProposal) != 0 {
		return ErrNotFound
	}
	return nil
}

func loadWorkspaceListRoles(ctx context.Context, tx *sql.Tx, items []workspaceListItem) error {
	var workspaceIDs []string
	byWorkspace := map[string]*Workspace{}
	roleIDs := map[string]map[string]bool{}
	for i := range items {
		workspace := &items[i].workspace
		if ids := workspaceRoleIDs(*workspace); len(ids) > 0 {
			workspaceIDs = append(workspaceIDs, workspace.ID)
			byWorkspace[workspace.ID] = workspace
			roleIDs[workspace.ID] = ids
		}
	}
	if len(workspaceIDs) == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+workspaceRoleColumns+`,workspace_id FROM workspace_roles
 WHERE workspace_id=ANY($1::uuid[]) ORDER BY id`, pq.Array(workspaceIDs))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var workspaceID string
		role, err := scanWorkspaceRole(rows, &workspaceID)
		if err != nil {
			return err
		}
		if roleIDs[workspaceID][role.RoleID] {
			workspace := byWorkspace[workspaceID]
			workspace.Roles = append(workspace.Roles, role)
		}
	}
	return rows.Err()
}
