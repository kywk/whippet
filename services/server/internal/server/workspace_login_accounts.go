package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/lib/pq"
)

const browserLoginAccountTool = "browser_login_account"

type AccountDescriptor struct {
	AccountID string                  `json:"accountId"`
	Name      string                  `json:"name"`
	Role      string                  `json:"role"`
	Purpose   string                  `json:"purpose"`
	Sites     []AccountSiteDescriptor `json:"sites"`
}

type AccountSiteDescriptor struct {
	TargetOrigin string `json:"targetOrigin"`
	State        string `json:"state"`
}

func setSavedWorkspaceTestDefaults(config *WorkspaceConfig) {
	if config != nil && config.TestAccounts == nil {
		config.TestAccounts = []TestAccount{}
		for _, role := range config.LoginRoles {
			if role.RoleID == nil {
				continue
			}
			account := TestAccount{AccountID: role.RoleID, Name: role.Name, Role: role.Name, Sites: []SiteLogin{}}
			for _, site := range config.Targets {
				if site.Origin == role.LoginOrigin {
					account.Sites = append(account.Sites, SiteLogin{TargetOrigin: site.Origin, LoginMethod: &role.LoginMethod})
				}
			}
			config.TestAccounts = append(config.TestAccounts, account)
		}
	}
	setWorkspaceTestDefaults(config)
}

func setAccountSnapshot(snapshot *WorkspaceContext, config *WorkspaceConfig, bindings []LoginBinding) {
	snapshot.SchemaVersion, snapshot.TestAccounts, snapshot.AccountBindings = "1", nil, nil
	if config == nil || len(bindings) == 0 {
		return
	}
	byAccount := make(map[string][]AccountSiteDescriptor)
	for _, binding := range bindings {
		byAccount[binding.AccountID] = append(byAccount[binding.AccountID], AccountSiteDescriptor{binding.TargetOrigin, "verified"})
	}
	for _, account := range config.TestAccounts {
		id := stringValue(account.AccountID)
		if sites := byAccount[id]; len(sites) != 0 {
			snapshot.TestAccounts = append(snapshot.TestAccounts, AccountDescriptor{id, account.Name, account.Role, account.Purpose, sites})
		}
	}
	if len(snapshot.TestAccounts) > 0 {
		snapshot.SchemaVersion = "2"
		snapshot.AccountBindings = bindings
	}
}

func snapshotAccountBinding(snapshot *WorkspaceContext, workspace, account, target string) *LoginBinding {
	if snapshot == nil || snapshot.SchemaVersion != "2" || snapshot.WorkspaceID != workspace {
		return nil
	}
	for i := range snapshot.AccountBindings {
		binding := &snapshot.AccountBindings[i]
		if binding.AccountID == account && binding.TargetOrigin == target {
			return binding
		}
	}
	return nil
}

func publicWorkspaceAccountContext(snapshot *WorkspaceContext) *WorkspaceContext {
	if snapshot != nil && snapshot.SchemaVersion == "2" {
		return scrubExternalContext(snapshot)
	}
	return snapshot
}

func formalAccountBindingAllowed(ctx context.Context, q queryDB, w Workspace, binding LoginBinding) error {
	if !confirmedCanonical(w) || w.Management.State == workspaceArchived {
		return ErrCredentialUnavailable
	}
	site, scope := accountSite(w.Settings, binding.AccountID, binding.TargetOrigin)
	state := w.loginState.Sites[binding.AccountID][binding.TargetOrigin]
	if site == nil || !testsAuthenticated(scope) || state.Version != binding.LoginConfigVersion {
		return ErrCredentialUnavailable
	}
	ref, err := accountCredential(ctx, q, w.ID, binding.AccountID)
	if err != nil {
		return err
	}
	if !state.verified(ref) {
		return ErrCredentialUnavailable
	}
	current, ok := currentLoginBinding(binding.AccountID, *site, state, ref)
	if !ok || jsonText(current) != jsonText(binding) {
		return ErrCredentialUnavailable
	}
	return nil
}

func cancelAccountConsumers(ctx context.Context, tx *sql.Tx, workspace, account, target string, includeVerification bool) error {
	var affected pq.StringArray
	err := tx.QueryRowContext(ctx, `SELECT ARRAY(SELECT r.id::text FROM runs r
 WHERE r.workspace_id=$1 AND r.status IN ('queued','dispatched','running','collecting')
 AND ( (r.kind<>$4 AND EXISTS (SELECT FROM jsonb_array_elements(r.resolved_account_bindings) b
        WHERE b->>'attemptId'=r.attempt_id::text AND b->>'accountId'=$2 AND ($3='' OR b->>'targetOrigin'=$3)))
       OR ($5 AND r.kind=$4 AND r.login_verification->'binding'->>'accountId'=$2 AND ($3='' OR r.login_verification->'binding'->>'targetOrigin'=$3))))`,
		workspace, account, target, workspaceLoginVerificationKind, includeVerification).Scan(&affected)
	if err != nil || len(affected) == 0 {
		return err
	}
	// External calls reserve the claim before locking its Run.
	if _, err := tx.ExecContext(ctx, `UPDATE external_author_claims SET state='cancelled' WHERE run_id=ANY($1::uuid[]) AND state='active'`, affected); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET status=CASE WHEN status='queued' OR author_engine='external' THEN 'cancelled' ELSE 'cancelling' END,
 finished_at=CASE WHEN status='queued' OR author_engine='external' THEN now() ELSE finished_at END,error='credential_unavailable'
 WHERE id=ANY($1::uuid[]) AND status IN ('queued','dispatched','running','collecting')`, affected); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE agent_browser_leases SET state='closing' WHERE author_run_id=ANY($1::uuid[])
 AND NOT reclaimed AND state IN ('opening','ready')`, affected)
	return err
}

func retireRemovedAccountAccess(ctx context.Context, tx *sql.Tx, w Workspace, config *WorkspaceConfig, formal workspaceLoginState) error {
	if w.Settings == nil {
		return nil
	}
	for _, account := range w.Settings.TestAccounts {
		id := stringValue(account.AccountID)
		if findTestAccount(config, id) == nil && configRole(config, id) == nil {
			if _, err := tx.ExecContext(ctx, `UPDATE workspace_roles SET configured=false WHERE workspace_id=$1 AND id=$2`, w.ID, id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE workspace_secrets SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND role_id=$2`, w.ID, id); err != nil {
				return err
			}
			if err := cancelRoleRuns(ctx, tx, w.ID, id); err != nil {
				return err
			}
		}
	}
	for account, sites := range w.loginState.Sites {
		for target, site := range sites {
			next := formal.Sites[account][target]
			if site.Proof != nil && (next.Proof == nil || next.Version != site.Version ||
				next.Proof.SecretRef != site.Proof.SecretRef || next.Proof.SecretVersion != site.Proof.SecretVersion) {
				if err := cancelAccountConsumers(ctx, tx, w.ID, account, target, false); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// Recheck the bindings a run actually used before issuing drafts or publishing.
func loadRunAccounts(ctx context.Context, q queryDB, runID string) error {
	var raw, scope []byte
	var workspace string
	var attempt *string
	if err := q.QueryRowContext(ctx, `SELECT workspace_id,attempt_id,resolved_account_bindings,workspace_context FROM runs WHERE id=$1`, runID).
		Scan(&workspace, &attempt, &raw, &scope); err != nil {
		return dbError(err)
	}
	var used []resolvedAccountBinding
	if err := json.Unmarshal(raw, &used); err != nil || len(used) == 0 {
		return err
	}
	w, _, err := readWorkspaceCore(ctx, q, workspace, false)
	if err != nil {
		return err
	}
	snapshot, err := decodeWorkspaceContext(scope)
	if err != nil {
		return err
	}
	for _, receipt := range used {
		binding := snapshotAccountBinding(snapshot, workspace, receipt.AccountID, receipt.TargetOrigin)
		if binding == nil || receipt != resolvedBinding(stringValue(attempt), *binding) {
			return ErrCredentialUnavailable
		}
		if err := formalAccountBindingAllowed(ctx, q, w, *binding); err != nil {
			return err
		}
	}
	return nil
}

type testAccountPatch struct {
	Revision int    `json:"revision"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Purpose  string `json:"purpose"`
}

func (p *Postgres) patchTestAccount(ctx context.Context, workspace, id string, request testAccountPatch) (Workspace, error) {
	request.Name, request.Role = strings.TrimSpace(request.Name), strings.TrimSpace(request.Role)
	if request.Revision < 1 || !configName(request.Name) || !configName(request.Role) || !configText(request.Purpose, 8192) {
		return Workspace{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback()
	w, current, err := lockWorkspaceSettings(ctx, tx, workspace)
	if err != nil {
		return w, err
	}
	if err := w.Management.State.workError(); err != nil {
		return w, err
	}
	account := findTestAccount(w.Settings, id)
	if account == nil {
		return w, ErrNotFound
	}
	if request.Revision != w.Revision {
		return w, ErrConflict
	}
	if account.Name != request.Name || account.Role != request.Role || account.Purpose != request.Purpose {
		account.Name, account.Role, account.Purpose = request.Name, request.Role, request.Purpose
		w.Revision++
		if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET canonical_config=$2,settings=$3 WHERE id=$1`,
			workspace, jsonText(w.Settings), settingsJSON(&w.WorkspaceSettings)); err != nil {
			return w, err
		}
		if err := invalidateWorkspaceLoginProposal(ctx, tx, workspace, current); err != nil {
			return w, err
		}
		if err := refreshWorkspaceDrafts(ctx, tx, workspace, p.Secrets != nil); err != nil {
			return w, err
		}
	}
	w, err = fillWorkspace(ctx, tx, w, current, p.Secrets != nil, p.CredentialTLS)
	if err != nil {
		return w, err
	}
	return w, tx.Commit()
}

func decodeAccountToolArguments(raw []byte) (account string, target string, err error) {
	var input struct {
		AccountID    string `json:"accountId"`
		TargetOrigin string `json:"targetOrigin"`
	}
	if !requiredJSONFields(raw, "accountId", "targetOrigin") || json.Unmarshal(raw, &input) != nil || !ValidID(input.AccountID) {
		return "", "", ErrInvalid
	}
	target, err = normalizedOrigin(input.TargetOrigin)
	return strings.ToLower(input.AccountID), target, err
}
