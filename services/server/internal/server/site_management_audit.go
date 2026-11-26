package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
)

type managementAudit struct {
	actorKind string
	actorID   string
	action    string
	target    string
	targetID  string
	workspace *string
	requestID *string
}

func platformAudit(actor platformActor, action, target, targetID string, workspace *string) managementAudit {
	kind, id := "user", actor.user.ID
	if actor.bootstrap {
		kind = "bootstrap"
	} else if id == "" {
		kind, id = "system", "server"
	}
	return managementAudit{actorKind: kind, actorID: id, action: action, target: target, targetID: targetID, workspace: workspace}
}

func (entry managementAudit) record(ctx context.Context, exec interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, outcome string, code *string) error {
	_, err := exec.ExecContext(ctx, `INSERT INTO site_management_audit(actor_kind,actor_id,action,target_type,target_id,workspace_id,outcome,code,request_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, entry.actorKind, entry.actorID, entry.action, entry.target, entry.targetID, entry.workspace, outcome, code, entry.requestID)
	return err
}

func (a *API) failManagement(w http.ResponseWriter, r *http.Request, actor platformActor, err error) {
	p, ok := a.store.(*Postgres)
	if !ok || actor.user.ID == "" {
		a.fail(w, err)
		return
	}
	id := r.PathValue("id")
	var workspace *string
	if ValidID(id) {
		workspace = &id
	}
	var entry managementAudit
	switch r.Pattern {
	case "PATCH /api/users/{userId}/role":
		entry = platformAudit(actor, "set_site_role", "user", r.PathValue("userId"), nil)
	case "PUT /api/workspaces/{id}/members/{userId}":
		entry = platformAudit(actor, "set_workspace_member", "user", r.PathValue("userId"), workspace)
	case "PATCH /api/admin/workspaces/{id}":
		entry = platformAudit(actor, "rename_workspace", "workspace", id, workspace)
	case "POST /api/admin/workspaces/{id}/archive":
		entry = platformAudit(actor, "archive_workspace", "workspace", id, workspace)
	case "POST /api/admin/workspaces/{id}/restore":
		entry = platformAudit(actor, "restore_workspace", "workspace", id, workspace)
	case "POST /api/runs/{id}/cancel":
		entry = platformAudit(actor, "cancel_run", "run", id, nil)
	case "POST /api/workspaces/{id}/agent-tokens":
		entry = platformAudit(actor, "create_agent_token", "workspace", id, workspace)
	case "DELETE /api/workspaces/{id}/agent-tokens/{tokenId}":
		entry = platformAudit(actor, "revoke_agent_token", "agent_token", r.PathValue("tokenId"), workspace)
	default:
		a.fail(w, err)
		return
	}
	outcome, code := "denied", "internal_error"
	switch {
	case errors.Is(err, errForbidden):
		code = "forbidden"
	case errors.Is(err, ErrNotFound):
		code = "not_found"
	case errors.Is(err, ErrInvalid):
		code = "invalid_request"
	case errors.Is(err, errLastSuper):
		code = "last_super_admin"
	case errors.Is(err, errManagementRevision):
		code = "stale_revision"
	case workspaceErrorCode(err) != "":
		code = workspaceErrorCode(err)
	case errors.Is(err, ErrConflict):
		code = "conflict"
	default:
		outcome = "failed"
	}
	if auditErr := entry.record(r.Context(), p.DB, outcome, &code); auditErr != nil {
		a.log.Error("site management audit failed", "action", entry.action, "code", code)
	}
	a.fail(w, err)
}
