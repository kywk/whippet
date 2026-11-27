package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
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

type AccountCredentialRequest struct {
	AccountID     string `json:"accountId"`
	TargetOrigin  string `json:"targetOrigin"`
	SecretRef     string `json:"secretRef"`
	SecretVersion int    `json:"secretVersion"`
}

type AccountCredentialResolution struct {
	WorkspaceID   string `json:"workspaceId"`
	RunID         string `json:"runId"`
	AttemptID     string `json:"attemptId"`
	AccountID     string `json:"accountId"`
	TargetOrigin  string `json:"targetOrigin"`
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
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil || strictJSONNoDuplicates(raw) != nil {
		a.fail(w, ErrInvalid)
		return
	}
	var account AccountCredentialRequest
	var legacy CredentialRequest
	switch {
	case requiredJSONFields(raw, "accountId", "targetOrigin", "secretRef", "secretVersion"):
		if json.Unmarshal(raw, &account) != nil || !ValidID(account.AccountID) || !ValidID(account.SecretRef) || account.SecretVersion < 1 {
			a.fail(w, ErrInvalid)
			return
		}
		target, err := normalizedOrigin(account.TargetOrigin)
		if err != nil {
			a.fail(w, ErrInvalid)
			return
		}
		account.TargetOrigin, account.AccountID = target, strings.ToLower(account.AccountID)
		account.SecretRef = strings.ToLower(account.SecretRef)
	case requiredJSONFields(raw, "roleId", "secretRef", "secretVersion"):
		if json.Unmarshal(raw, &legacy) != nil || !ValidID(legacy.RoleID) || !ValidID(legacy.SecretRef) || legacy.SecretVersion < 1 {
			a.fail(w, ErrInvalid)
			return
		}
	default:
		a.fail(w, ErrInvalid)
		return
	}
	if a.engine == nil {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	manager, epoch, ready := a.engine.credentialManager()
	if !ready {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	var value any
	if account.AccountID != "" {
		p, ok := a.store.(*Postgres)
		if !ok {
			a.fail(w, ErrCredentialUnavailable)
			return
		}
		value, err = p.resolveRunAccountCredentials(r.Context(), manager, id, attempt, account)
	} else {
		value, err = a.store.ResolveWorkspaceCredentials(r.Context(), manager, id, attempt, legacy)
	}
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

func (p *Postgres) openAccountSecret(ctx context.Context, q queryDB, workspace string, binding LoginBinding) (credentialValues, error) {
	var nonce, encrypted []byte
	err := q.QueryRowContext(ctx, `SELECT nonce,ciphertext FROM workspace_secrets WHERE workspace_id=$1 AND role_id=$2
 AND secret_ref=$3 AND secret_version=$4 AND revoked_at IS NULL`,
		workspace, binding.AccountID, binding.SecretRef, binding.SecretVersion).Scan(&nonce, &encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return credentialValues{}, ErrCredentialUnavailable
	}
	if err != nil {
		return credentialValues{}, err
	}
	values, err := p.Secrets.open(workspace, binding.AccountID, binding.SecretRef, binding.SecretVersion, nonce, encrypted)
	if err != nil || !validOutputText(values.Username, 4096) || !validOutputText(values.Password, 4096) {
		return credentialValues{}, ErrSecretsUnavailable
	}
	return values, nil
}

func (p *Postgres) resolveRunAccountCredentials(ctx context.Context, manager, run, attempt string, request AccountCredentialRequest) (AccountCredentialResolution, error) {
	var result AccountCredentialResolution
	if p.Secrets == nil {
		return result, ErrSecretsUnavailable
	}
	if !p.readyForWorkspaceLogin() {
		return result, ErrCredentialUnavailable
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var workspace, kind string
	if err := tx.QueryRowContext(ctx, `SELECT workspace_id,kind FROM runs WHERE id=$1 AND manager_id=$2 AND attempt_id=$3`, run, manager, attempt).
		Scan(&workspace, &kind); err != nil {
		return result, dbError(err)
	}
	var saved persistedWorkspaceLogin
	if kind == workspaceLoginVerificationKind {
		saved, err = readPersistedWorkspaceLogin(ctx, tx, run)
		if err != nil {
			return result, err
		}
		if _, err := lockActorSiteRole(ctx, tx, saved.Actor); err != nil {
			if errors.Is(err, ErrNotFound) {
				return result, ErrCredentialUnavailable
			}
			return result, err
		}
	}
	w, current, err := readWorkspaceCore(ctx, tx, workspace, true)
	if err != nil {
		return result, err
	}
	var status string
	var released bool
	var raw []byte
	if err := tx.QueryRowContext(ctx, `SELECT status,slot_released,workspace_context FROM runs
 WHERE id=$1 AND manager_id=$2 AND attempt_id=$3 FOR UPDATE`, run, manager, attempt).Scan(&status, &released, &raw); err != nil {
		return result, dbError(err)
	}
	if released || status != "running" && status != "dispatched" {
		return result, ErrCredentialUnavailable
	}
	var binding LoginBinding
	if kind == workspaceLoginVerificationKind {
		if saved.Deadline == nil || !time.Now().Before(*saved.Deadline) {
			return result, ErrCredentialUnavailable
		}
		binding = saved.Login.Binding
		if binding.AccountID != request.AccountID || binding.TargetOrigin != request.TargetOrigin {
			return result, ErrCredentialUnavailable
		}
		if _, err := activeWorkspaceLogin(ctx, tx, w, current, run, saved.Login, saved.Actor); err != nil {
			if workspaceLoginInactive(err) {
				return result, ErrCredentialUnavailable
			}
			return result, err
		}
	} else {
		snapshot, err := decodeWorkspaceContext(raw)
		if err != nil {
			return result, err
		}
		allowed := snapshotAccountBinding(snapshot, workspace, request.AccountID, request.TargetOrigin)
		if allowed == nil {
			return result, ErrCredentialUnavailable
		}
		binding = *allowed
		if err := formalAccountBindingAllowed(ctx, tx, w, binding); err != nil {
			return result, err
		}
	}
	if binding.SecretRef != request.SecretRef || binding.SecretVersion != request.SecretVersion {
		return result, ErrCredentialUnavailable
	}
	values, err := p.openAccountSecret(ctx, tx, workspace, binding)
	if err != nil {
		return result, err
	}
	origin, err := workspaceURLOrigin(binding.EntryURL)
	if err != nil {
		return result, ErrCredentialUnavailable
	}
	if err := recordResolvedAccount(ctx, tx, run, attempt, binding); err != nil {
		return result, err
	}
	result = AccountCredentialResolution{workspace, run, attempt, binding.AccountID, binding.TargetOrigin, binding.SecretRef, binding.SecretVersion, origin, values.Username, values.Password}
	return result, tx.Commit()
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
