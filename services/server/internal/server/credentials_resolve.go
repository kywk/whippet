package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
)

type CredentialRequest struct {
	RoleID        string `json:"roleId"`
	SecretRef     string `json:"secretRef"`
	SecretVersion int    `json:"secretVersion"`
}
type CredentialResolution struct {
	WorkspaceID   string `json:"workspaceId"`
	RunID         string `json:"runId"`
	AttemptID     string `json:"attemptId"`
	RoleID        string `json:"roleId"`
	SecretRef     string `json:"secretRef"`
	SecretVersion int    `json:"secretVersion"`
	LoginOrigin   string `json:"loginOrigin"`
	Username      string `json:"username"`
	Password      string `json:"password"`
}

func (e *Engine) credentialManager() (string, string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.session == nil || !e.session.ready {
		return "", "", false
	}
	return e.session.managerID, e.session.liveEpoch, true
}
func (a *API) resolveCredentials(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.TLS == nil {
		writeError(w, 400, "protected_transport_required", "Manager credential resolution requires TLS")
		return
	}
	id, attempt := r.PathValue("id"), r.PathValue("attemptId")
	if !ValidID(id) || !ValidID(attempt) {
		a.fail(w, ErrInvalid)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request CredentialRequest
	if err := decodeBody(w, r, &request); err != nil {
		a.fail(w, err)
		return
	}
	if !ValidID(request.RoleID) || !ValidID(request.SecretRef) || request.SecretVersion < 1 {
		a.fail(w, ErrInvalid)
		return
	}
	manager, epoch, ready := a.engine.credentialManager()
	if !ready {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	value, err := a.store.ResolveWorkspaceCredentials(r.Context(), manager, id, attempt, request)
	if err != nil {
		a.fail(w, err)
		return
	}
	current, currentEpoch, ready := a.engine.credentialManager()
	if !ready || manager != current || epoch != currentEpoch {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	writeJSON(w, 200, value)
}

func taskRole(snapshot *WorkspaceContext, request CredentialRequest) (*WorkspaceRole, error) {
	if snapshot == nil {
		return nil, ErrNotFound
	}
	role := configRole(snapshot.Config, request.RoleID)
	if role == nil || role.LoginMethod != "form" || !loginOriginAllowed(snapshot.Config, role.LoginOrigin) {
		return nil, ErrNotFound
	}
	for _, ref := range snapshot.RoleRefs {
		if ref.RoleID == request.RoleID {
			if ref.SecretRef == nil || *ref.SecretRef != request.SecretRef {
				return nil, ErrNotFound
			}
			if !ref.Configured || ref.SecretVersion == nil || *ref.SecretVersion != request.SecretVersion {
				return nil, ErrCredentialUnavailable
			}
			return role, nil
		}
	}
	return nil, ErrNotFound
}

func (p *Postgres) ResolveWorkspaceCredentials(ctx context.Context, manager, run, attempt string, request CredentialRequest) (CredentialResolution, error) {
	var result CredentialResolution
	if p.Secrets == nil {
		return result, ErrSecretsUnavailable
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var workspace string
	if err = tx.QueryRowContext(ctx, `SELECT workspace_id FROM runs WHERE id=$1`, run).Scan(&workspace); err != nil {
		return result, dbError(err)
	}
	w, pid, err := readWorkspaceCore(ctx, tx, workspace, true)
	if err != nil {
		return result, err
	}
	w, err = fillWorkspace(ctx, tx, w, pid, true, p.CredentialTLS)
	if err != nil {
		return result, err
	}
	var assigned, activeAttempt sql.NullString
	var status string
	var released bool
	var raw []byte
	if err = tx.QueryRowContext(ctx, `SELECT manager_id,attempt_id,status,slot_released,workspace_context FROM runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, run, workspace).Scan(&assigned, &activeAttempt, &status, &released, &raw); err != nil {
		return result, dbError(err)
	}
	if !assigned.Valid || assigned.String != manager || !activeAttempt.Valid || activeAttempt.String != attempt || released || (status != "running" && status != "dispatched") {
		return result, ErrCredentialUnavailable
	}
	snapshot, err := decodeWorkspaceContext(raw)
	if err != nil {
		return result, err
	}
	if snapshot == nil || snapshot.WorkspaceID != workspace {
		return result, ErrNotFound
	}
	role, err := taskRole(snapshot, request)
	if err != nil {
		return result, err
	}
	if !confirmedLogin(w, request.RoleID, role.LoginOrigin) {
		return result, ErrCredentialUnavailable
	}
	var configured bool
	var ref sql.NullString
	var version sql.NullInt64
	if err = tx.QueryRowContext(ctx, `SELECT configured,secret_ref,secret_version FROM workspace_roles WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, request.RoleID, workspace).Scan(&configured, &ref, &version); err != nil {
		return result, dbError(err)
	}
	if !configured || !ref.Valid || ref.String != request.SecretRef || !version.Valid || version.Int64 != int64(request.SecretVersion) {
		return result, ErrCredentialUnavailable
	}
	var nonce, sealed []byte
	err = tx.QueryRowContext(ctx, `SELECT nonce,ciphertext FROM workspace_secrets WHERE workspace_id=$1 AND role_id=$2 AND secret_ref=$3 AND secret_version=$4 AND revoked_at IS NULL`, workspace, request.RoleID, request.SecretRef, request.SecretVersion).Scan(&nonce, &sealed)
	if errors.Is(err, sql.ErrNoRows) {
		return result, ErrCredentialUnavailable
	}
	if err != nil {
		return result, err
	}
	values, err := p.Secrets.open(workspace, request.RoleID, request.SecretRef, request.SecretVersion, nonce, sealed)
	if err != nil || !validOutputText(values.Username, 4096) || !validOutputText(values.Password, 4096) {
		return result, ErrSecretsUnavailable
	}
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET resolved_role_ids=CASE WHEN $2::uuid=ANY(resolved_role_ids) THEN resolved_role_ids ELSE array_append(resolved_role_ids,$2::uuid) END WHERE id=$1`, run, request.RoleID); err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	return CredentialResolution{WorkspaceID: workspace, RunID: run, AttemptID: attempt, RoleID: request.RoleID, SecretRef: request.SecretRef, SecretVersion: request.SecretVersion, LoginOrigin: role.LoginOrigin, Username: values.Username, Password: values.Password}, nil
}
