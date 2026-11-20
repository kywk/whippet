package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

const (
	developmentAdmin          = "dev-admin"
	developmentWorkspaceAdmin = "dev-workspace-admin"
	developmentQA             = "dev-qa"
)

var (
	errForbidden = errors.New("權限不足")
	errLastSuper = fmt.Errorf("%w: 至少需要保留一位 Super Admin", ErrConflict)
)

type siteRole string

const (
	superAdmin siteRole = "superadmin"
	siteAdmin  siteRole = "site_admin"
	noSiteRole siteRole = "none"
)

func (r siteRole) admin() bool { return r == superAdmin || r == siteAdmin }

type memberRole string

const (
	workspaceAdmin memberRole = "workspace_admin"
	workspaceQA    memberRole = "qa"
	noMemberRole   memberRole = "none"
)

type sitePermissions struct {
	CreateWorkspace   bool `json:"createWorkspace"`
	ManageUsers       bool `json:"manageUsers"`
	ManageSuperAdmins bool `json:"manageSuperAdmins"`
}

type platformUser struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Role        siteRole        `json:"role"`
	Permissions sitePermissions `json:"permissions"`
}

func presentUser(id, name string, role siteRole) platformUser {
	return platformUser{
		ID: id, Name: name, Role: role,
		Permissions: sitePermissions{
			CreateWorkspace: role.admin(), ManageUsers: role.admin(), ManageSuperAdmins: role == superAdmin,
		},
	}
}

type platformActor struct {
	user      platformUser
	bootstrap bool
}

type workspacePermissions struct {
	ManageTests           bool `json:"manageTests"`
	ManageSettings        bool `json:"manageSettings"`
	ManageMembers         bool `json:"manageMembers"`
	ManageWorkspaceAdmins bool `json:"manageWorkspaceAdmins"`
	ManageAgentTokens     bool `json:"manageAgentTokens"`
}

func permissionsForWorkspace(site siteRole, member memberRole) workspacePermissions {
	manageWorkspace := site.admin() || member == workspaceAdmin
	return workspacePermissions{
		ManageTests:    manageWorkspace || member == workspaceQA,
		ManageSettings: manageWorkspace, ManageMembers: manageWorkspace,
		ManageWorkspaceAdmins: site.admin(), ManageAgentTokens: site == superAdmin,
	}
}

type workspaceMember struct {
	ID   string     `json:"id"`
	Name string     `json:"name"`
	Role memberRole `json:"role"`
}

func scanPlatformUser(row scanner) (platformUser, error) {
	var id, name string
	var role siteRole
	err := row.Scan(&id, &name, &role)
	return presentUser(id, name, role), dbError(err)
}

func (p *Postgres) platformUser(ctx context.Context, id string) (platformUser, error) {
	return scanPlatformUser(p.DB.QueryRowContext(ctx, `SELECT id,display_name,site_role FROM platform_users WHERE id=$1`, id))
}

func readPlatformUsers(ctx context.Context, q queryDB, lock bool) ([]platformUser, error) {
	query := `SELECT id,display_name,site_role FROM platform_users ORDER BY id`
	if lock {
		query += " FOR NO KEY UPDATE"
	}
	rows, err := q.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []platformUser{}
	for rows.Next() {
		user, err := scanPlatformUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (p *Postgres) setSiteRole(ctx context.Context, actor platformActor, id string, role siteRole) (platformUser, error) {
	if role != superAdmin && role != siteAdmin && role != noSiteRole {
		return platformUser{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return platformUser{}, err
	}
	defer tx.Rollback()

	// The directory is fixed and small. Lock it in ID order so concurrent
	// edits see the current actor role and cannot remove the last Super Admin.
	users, err := readPlatformUsers(ctx, tx, true)
	if err != nil {
		return platformUser{}, err
	}
	var current platformUser
	actorRole, supers := noSiteRole, 0
	for _, user := range users {
		if user.ID == id {
			current = user
		}
		if user.ID == actor.user.ID {
			actorRole = user.Role
		}
		if user.Role == superAdmin {
			supers++
		}
	}
	if actor.bootstrap {
		actorRole = superAdmin
	}
	if !actorRole.admin() {
		return platformUser{}, errForbidden
	}
	if current.ID == "" {
		return platformUser{}, ErrNotFound
	}
	if actorRole != superAdmin && (role == superAdmin || current.Role == superAdmin) {
		return platformUser{}, errForbidden
	}
	if supers == 1 && current.Role == superAdmin && role != superAdmin {
		return platformUser{}, errLastSuper
	}
	if _, err := tx.ExecContext(ctx, `UPDATE platform_users SET site_role=$2 WHERE id=$1`, id, role); err != nil {
		return platformUser{}, err
	}
	return presentUser(id, current.Name, role), tx.Commit()
}

func readMemberRole(ctx context.Context, q queryDB, workspaceID, userID string) (memberRole, error) {
	var role memberRole
	err := q.QueryRowContext(ctx, `SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return noMemberRole, nil
	}
	return role, err
}

func (p *Postgres) workspaceMembers(ctx context.Context, workspaceID string) ([]workspaceMember, error) {
	rows, err := p.DB.QueryContext(ctx, `SELECT u.id,u.display_name,COALESCE(m.role,'none')
FROM platform_users u LEFT JOIN workspace_memberships m ON m.user_id=u.id AND m.workspace_id=$1
ORDER BY u.id`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []workspaceMember{}
	for rows.Next() {
		var member workspaceMember
		if err := rows.Scan(&member.ID, &member.Name, &member.Role); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (p *Postgres) setWorkspaceMember(ctx context.Context, actor platformActor, workspaceID, userID string, role memberRole) (workspaceMember, error) {
	if role != workspaceAdmin && role != workspaceQA && role != noMemberRole {
		return workspaceMember{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return workspaceMember{}, err
	}
	defer tx.Rollback()
	actorRole := superAdmin
	if !actor.bootstrap {
		if err := tx.QueryRowContext(ctx, `SELECT site_role FROM platform_users WHERE id=$1 FOR SHARE`, actor.user.ID).Scan(&actorRole); err != nil {
			return workspaceMember{}, dbError(err)
		}
	}
	// A workspace-row lock covers additions as well as edits and removals.
	if err := tx.QueryRowContext(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, workspaceID).Scan(&workspaceID); err != nil {
		return workspaceMember{}, dbError(err)
	}
	if !actorRole.admin() {
		actorMember, err := readMemberRole(ctx, tx, workspaceID, actor.user.ID)
		if err != nil {
			return workspaceMember{}, err
		}
		current, err := readMemberRole(ctx, tx, workspaceID, userID)
		if err != nil {
			return workspaceMember{}, err
		}
		if actorMember != workspaceAdmin || role == workspaceAdmin || current == workspaceAdmin {
			return workspaceMember{}, errForbidden
		}
	}
	member := workspaceMember{ID: userID, Role: role}
	if err := tx.QueryRowContext(ctx, `SELECT display_name FROM platform_users WHERE id=$1`, userID).Scan(&member.Name); err != nil {
		return workspaceMember{}, dbError(err)
	}
	if role == noMemberRole {
		_, err = tx.ExecContext(ctx, `DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID)
	} else {
		_, err = tx.ExecContext(ctx, `INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)
ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role`, workspaceID, userID, role)
	}
	if err != nil {
		return workspaceMember{}, err
	}
	return member, tx.Commit()
}

func presentWorkspace(workspace Workspace, permissions workspacePermissions) Workspace {
	workspace.Permissions = &permissions
	if !permissions.ManageSettings {
		workspace.ConversationID = ""
		workspace.CurrentProposal = nil
		workspace.ActiveRunID = nil
		workspace.Roles = []RoleRef{}
		workspace.SecretsAvailable = false
	}
	return workspace
}
