package server

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/lib/pq"
)

const workspaceLoginVerificationKind = "workspace_login_verification"

type LoginBinding struct {
	AccountID          string        `json:"accountId"`
	TargetOrigin       string        `json:"targetOrigin"`
	LoginConfigVersion string        `json:"loginConfigVersion"`
	EntryURL           string        `json:"entryUrl"`
	Form               FormSelectors `json:"form"`
	Success            SuccessCheck  `json:"success"`
	SecretRef          string        `json:"secretRef"`
	SecretVersion      int           `json:"secretVersion"`
}

type LoginVerification struct {
	ProposalID      string       `json:"proposalId"`
	BaseRevision    int          `json:"baseRevision"`
	ContextRevision int64        `json:"contextRevision"`
	ScopeHash       string       `json:"scopeHash"`
	Binding         LoginBinding `json:"binding"`
}

// The Workspace row serializes proposal and formal login state. Bindings are
// keyed by account and normalized target so a change at one site is local.
type workspaceLoginState struct {
	Sites       map[string]map[string]loginSiteState `json:"sites,omitempty"`
	Credentials map[string]proposalCredential        `json:"credentials,omitempty"`
}

type loginSiteState struct {
	Version string      `json:"version"`
	RunID   *string     `json:"runId,omitempty"`
	Proof   *loginProof `json:"proof,omitempty"`
}

type loginProof struct {
	SecretRef     string    `json:"secretRef"`
	SecretVersion int       `json:"secretVersion"`
	VerifiedAt    time.Time `json:"verifiedAt"`
}

type proposalCredential struct {
	BaseVersion    *int    `json:"baseVersion"`
	BaseConfigured bool    `json:"baseConfigured"`
	SecretRef      *string `json:"secretRef"`
	SecretVersion  *int    `json:"secretVersion"`
	Configured     bool    `json:"configured"`
}

func (d proposalCredential) matchesBase(official RoleRef) bool {
	return secretVersion(d.BaseVersion) == secretVersion(official.SecretVersion) && d.BaseConfigured == official.Configured
}

func secretVersion(version *int) int {
	if version == nil {
		return 0
	}
	return *version
}

func accountSite(config *WorkspaceConfig, accountID, target string) (*SiteLogin, TestScope) {
	if config == nil {
		return nil, ""
	}
	var scope TestScope
	for _, site := range config.Targets {
		if site.Origin == target {
			scope = site.TestScope
			break
		}
	}
	for _, account := range config.TestAccounts {
		if stringValue(account.AccountID) == accountID {
			for i := range account.Sites {
				if account.Sites[i].TargetOrigin == target {
					return &account.Sites[i], scope
				}
			}
		}
	}
	return nil, scope
}

func testsAuthenticated(scope TestScope) bool {
	return scope == testScopeAuthenticated || scope == testScopeBoth
}

func completeLoginForm(site SiteLogin) bool {
	return stringValue(site.LoginMethod) == "form" && site.EntryURL != nil && site.Form != nil && site.Success != nil
}

func currentLoginBinding(accountID string, site SiteLogin, current loginSiteState, ref RoleRef) (LoginBinding, bool) {
	if !ValidID(current.Version) || !completeLoginForm(site) || !ref.Configured || ref.SecretRef == nil || secretVersion(ref.SecretVersion) < 1 {
		return LoginBinding{}, false
	}
	return LoginBinding{
		AccountID: accountID, TargetOrigin: site.TargetOrigin, LoginConfigVersion: current.Version,
		EntryURL: *site.EntryURL, Form: *site.Form, Success: *site.Success,
		SecretRef: *ref.SecretRef, SecretVersion: *ref.SecretVersion,
	}, true
}

func (state loginSiteState) verified(ref RoleRef) bool {
	return state.RunID != nil && state.Proof != nil && ref.Configured && state.Proof.SecretRef == stringValue(ref.SecretRef) &&
		state.Proof.SecretVersion == secretVersion(ref.SecretVersion)
}

func accountCredential(ctx context.Context, q queryDB, workspace, account string) (RoleRef, error) {
	ref, err := scanWorkspaceRole(q.QueryRowContext(ctx, `SELECT a.id,a.secret_ref,a.secret_version,a.configured AND
 EXISTS (SELECT FROM workspace_secrets s WHERE s.workspace_id=a.workspace_id AND s.role_id=a.id
 AND s.secret_ref=a.secret_ref AND s.secret_version=a.secret_version AND s.revoked_at IS NULL)
 FROM workspace_roles a WHERE a.workspace_id=$1 AND a.id=$2`, workspace, account))
	if errors.Is(err, sql.ErrNoRows) {
		return RoleRef{RoleID: account}, nil
	}
	return ref, err
}

func effectiveProposalCredential(ctx context.Context, q queryDB, workspace, account string, draft *proposalCredential) (RoleRef, error) {
	official, err := accountCredential(ctx, q, workspace, account)
	if err != nil || draft == nil {
		return official, err
	}
	ref := RoleRef{RoleID: account, SecretRef: draft.SecretRef, SecretVersion: draft.SecretVersion}
	if draft.Configured && draft.matchesBase(official) {
		err = q.QueryRowContext(ctx, `SELECT EXISTS (SELECT FROM workspace_secrets WHERE workspace_id=$1 AND role_id=$2
 AND secret_ref=$3 AND secret_version=$4 AND revoked_at IS NULL)`, workspace, account, ref.SecretRef, ref.SecretVersion).Scan(&ref.Configured)
	}
	return ref, err
}

type loginRunStatus struct {
	status string
	reason *string
}

func workspaceLoginProgress(ctx context.Context, q queryDB, workspace string, state workspaceLoginState) (map[string]loginRunStatus, error) {
	out := make(map[string]loginRunStatus)
	var runIDs []string
	for _, sites := range state.Sites {
		for _, site := range sites {
			if site.RunID != nil && site.Proof == nil {
				runIDs = append(runIDs, *site.RunID)
			}
		}
	}
	if len(runIDs) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT id,status,error FROM runs WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind=$3`,
		workspace, pq.Array(runIDs), workspaceLoginVerificationKind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var run loginRunStatus
		if err := rows.Scan(&id, &run.status, &run.reason); err != nil {
			return nil, err
		}
		out[id] = run
	}
	return out, rows.Err()
}

func projectWorkspaceLogin(ctx context.Context, q queryDB, workspace string, config *WorkspaceConfig, state workspaceLoginState, scopeConfirmed bool) ([]SiteReadiness, []AccountCredentialStatus, []LoginBinding, error) {
	readiness := workspaceSiteReadiness(config, scopeConfirmed)
	credentials := []AccountCredentialStatus{}
	bindings := []LoginBinding{}
	if config == nil || len(config.TestAccounts) == 0 {
		return readiness, credentials, bindings, nil
	}
	refs := make(map[string]RoleRef)
	for _, account := range config.TestAccounts {
		id := stringValue(account.AccountID)
		var draft *proposalCredential
		if saved, ok := state.Credentials[id]; ok {
			draft = &saved
		}
		ref, err := effectiveProposalCredential(ctx, q, workspace, id, draft)
		if err != nil {
			return nil, nil, nil, err
		}
		refs[id] = ref
		credentials = append(credentials, AccountCredentialStatus{id, ref.Configured, ref.SecretVersion})
	}
	progress, err := workspaceLoginProgress(ctx, q, workspace, state)
	if err != nil {
		return nil, nil, nil, err
	}
	for i := range readiness {
		site := &readiness[i]
		for j := range site.Accounts {
			account := &site.Accounts[j]
			current := state.Sites[account.AccountID][site.TargetOrigin]
			ref := refs[account.AccountID]
			if scopeConfirmed && ref.Configured && stringValue(account.Reason) == "credentials_required" {
				account.Reason = nil
			}
			if !scopeConfirmed || !testsAuthenticated(site.TestScope) || current.RunID == nil {
				continue
			}
			if login, _ := accountSite(config, account.AccountID, site.TargetOrigin); login != nil && current.verified(ref) {
				if binding, ok := currentLoginBinding(account.AccountID, *login, current, ref); ok {
					account.State, account.Reason, account.RunID = "verified", nil, current.RunID
					at := current.Proof.VerifiedAt.UTC()
					account.VerifiedAt = &at
					site.Ready, site.Reason = true, nil
					bindings = append(bindings, binding)
					continue
				}
			}
			if run, ok := progress[*current.RunID]; ok {
				account.RunID, account.State, account.Reason = current.RunID, "running", nil
				if Terminal(run.status) {
					account.State = "failed"
					switch run.status {
					case "cancelled", "timed_out", "interrupted":
						account.Reason = stringPointer(run.status)
					default:
						reason := stringValue(run.reason)
						if !validLoginFailure(reason) {
							reason = "invalid_evidence"
						}
						account.Reason = stringPointer(reason)
					}
				}
			}
		}
	}
	return readiness, credentials, bindings, nil
}
