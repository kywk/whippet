package server

import (
	"context"
	"database/sql"
	"errors"
)

func pendingWorkspaceProposal(ctx context.Context, q queryDB, w Workspace, currentID *string, proposal WorkspaceProposal, base int) error {
	if err := w.Management.State.workError(); err != nil {
		return err
	}
	if currentID == nil || *currentID != proposal.ID || proposal.Status != "pending" || proposal.BaseRevision != w.Revision || base != w.Revision {
		return ErrConflict
	}
	var revision int64
	if err := q.QueryRowContext(ctx, `SELECT context_revision FROM conversations WHERE workspace_id=$1 AND id=$2 AND owner_type='workspace'`,
		w.ID, proposal.ConversationID).Scan(&revision); err != nil {
		return dbError(err)
	}
	if revision != proposal.ContextRevision {
		return ErrConflict
	}
	return nil
}

func findTestAccount(config *WorkspaceConfig, id string) *TestAccount {
	if config != nil {
		for i := range config.TestAccounts {
			if stringValue(config.TestAccounts[i].AccountID) == id {
				return &config.TestAccounts[i]
			}
		}
	}
	return nil
}

func ensureWorkspaceAccount(ctx context.Context, tx *sql.Tx, workspace, account string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO workspace_roles(id,workspace_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, account, workspace)
	if err != nil {
		return err
	}
	var owner string
	if err := tx.QueryRowContext(ctx, `SELECT workspace_id FROM workspace_roles WHERE id=$1`, account).Scan(&owner); err != nil {
		return err
	}
	if owner != workspace {
		return ErrNotFound
	}
	return nil
}

func nextAccountSecret(ctx context.Context, tx *sql.Tx, workspace, account string) (ref string, version int, err error) {
	err = tx.QueryRowContext(ctx, `SELECT secret_ref,secret_version FROM workspace_secrets WHERE workspace_id=$1 AND role_id=$2
 ORDER BY secret_version DESC LIMIT 1`, workspace, account).Scan(&ref, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return NewID(), 1, nil
	}
	return ref, version + 1, err
}

func (p *Postgres) sealAccountSecret(ctx context.Context, tx *sql.Tx, workspace, account string, values credentialValues) (string, int, error) {
	ref, version, err := nextAccountSecret(ctx, tx, workspace, account)
	if err != nil {
		return "", 0, err
	}
	nonce, sealed, err := p.Secrets.seal(workspace, account, ref, version, values)
	if err != nil {
		return "", 0, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO workspace_secrets(workspace_id,role_id,secret_ref,secret_version,nonce,ciphertext) VALUES($1,$2,$3,$4,$5,$6)`,
		workspace, account, ref, version, nonce, sealed)
	return ref, version, err
}

func revokeDraftSecret(ctx context.Context, tx *sql.Tx, workspace, account string, draft proposalCredential) error {
	if draft.SecretRef == nil {
		return nil
	}
	_, err := tx.ExecContext(ctx, `UPDATE workspace_secrets s SET revoked_at=COALESCE(revoked_at,now())
 WHERE s.workspace_id=$1 AND s.role_id=$2 AND s.secret_ref=$3 AND s.secret_version=$4
 AND NOT EXISTS (SELECT FROM workspace_roles a WHERE a.id=s.role_id AND a.workspace_id=s.workspace_id AND a.configured
 AND a.secret_ref=s.secret_ref AND a.secret_version=s.secret_version)`, workspace, account, draft.SecretRef, draft.SecretVersion)
	return err
}

func cancelProposalLoginRuns(ctx context.Context, tx *sql.Tx, workspace, proposalID, account string) error {
	_, err := tx.ExecContext(ctx, `UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,
 finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END
 WHERE workspace_id=$1 AND scope_proposal_id=$2 AND kind=$3 AND status IN ('queued','dispatched','running','collecting')
 AND ($4='' OR login_verification->'binding'->>'accountId'=$4)`, workspace, proposalID, workspaceLoginVerificationKind, account)
	return err
}

func retireProposalLogin(ctx context.Context, tx *sql.Tx, previous WorkspaceProposal, carried workspaceLoginState) error {
	if err := cancelProposalLoginRuns(ctx, tx, previous.WorkspaceID, previous.ID, ""); err != nil {
		return err
	}
	for id, credential := range previous.loginState.Credentials {
		if next, ok := carried.Credentials[id]; ok && stringValue(next.SecretRef) == stringValue(credential.SecretRef) &&
			secretVersion(next.SecretVersion) == secretVersion(credential.SecretVersion) {
			continue
		}
		if err := revokeDraftSecret(ctx, tx, previous.WorkspaceID, id, credential); err != nil {
			return err
		}
	}
	return nil
}

func invalidateWorkspaceLoginProposal(ctx context.Context, tx *sql.Tx, workspace string, current *string) error {
	if current == nil {
		return nil
	}
	proposal, err := readProposal(ctx, tx, workspace, *current, true)
	if err != nil {
		return err
	}
	if proposal.Status != "pending" && !(proposal.Status == "stale" && stringValue(proposal.InvalidationReason) == "context_changed") {
		return nil
	}
	if err := retireProposalLogin(ctx, tx, proposal, workspaceLoginState{}); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE workspace_proposals SET status='stale',invalidation_reason='base_revision_changed',
 scope_confirmed=false WHERE id=$1`, *current)
	return err
}

func saveProposalLoginState(ctx context.Context, tx *sql.Tx, proposal WorkspaceProposal) error {
	_, err := tx.ExecContext(ctx, `UPDATE workspace_proposals SET login_state=$2 WHERE id=$1`, proposal.ID, jsonText(proposal.loginState))
	return err
}

func (p *Postgres) changeProposalCredentials(ctx context.Context, workspace, proposalID, account string, base, expected int, values *credentialValues) (AccountCredentialStatus, error) {
	result := AccountCredentialStatus{AccountID: account}
	if p.Secrets == nil {
		return result, ErrSecretsUnavailable
	}
	if expected < 0 || values != nil && (!validOutputText(values.Username, 4096) || !validOutputText(values.Password, 4096)) {
		return result, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	w, current, err := lockWorkspaceSettings(ctx, tx, workspace)
	if err != nil {
		return result, err
	}
	workspace = w.ID
	proposal, err := readProposal(ctx, tx, workspace, proposalID, true)
	if err != nil {
		return result, err
	}
	if err := pendingWorkspaceProposal(ctx, tx, w, current, proposal, base); err != nil {
		return result, err
	}
	if findTestAccount(&proposal.Content, account) == nil {
		return result, ErrNotFound
	}
	if err := ensureWorkspaceAccount(ctx, tx, workspace, account); err != nil {
		return result, err
	}
	official, err := accountCredential(ctx, tx, workspace, account)
	if err != nil {
		return result, err
	}
	draft, exists := proposal.loginState.Credentials[account]
	if !exists {
		draft = proposalCredential{official.SecretVersion, official.Configured, official.SecretRef, official.SecretVersion, official.Configured}
	}
	if !draft.matchesBase(official) || expected != secretVersion(draft.SecretVersion) {
		return result, ErrConflict
	}
	if err := revokeDraftSecret(ctx, tx, workspace, account, draft); err != nil {
		return result, err
	}
	draft.Configured = values != nil
	if values != nil {
		ref, version, err := p.sealAccountSecret(ctx, tx, workspace, account, *values)
		if err != nil {
			return result, err
		}
		draft.SecretRef, draft.SecretVersion = &ref, &version
	}
	if proposal.loginState.Credentials == nil {
		proposal.loginState.Credentials = make(map[string]proposalCredential)
	}
	proposal.loginState.Credentials[account] = draft
	for target, site := range proposal.loginState.Sites[account] {
		site.Proof, site.RunID = nil, nil
		proposal.loginState.Sites[account][target] = site
	}
	if err := saveProposalLoginState(ctx, tx, proposal); err != nil {
		return result, err
	}
	if err := cancelProposalLoginRuns(ctx, tx, workspace, proposalID, account); err != nil {
		return result, err
	}
	return AccountCredentialStatus{account, draft.Configured, draft.SecretVersion}, tx.Commit()
}

func deriveProposalLoginState(ctx context.Context, tx *sql.Tx, w Workspace, config *WorkspaceConfig, prior *WorkspaceProposal) (workspaceLoginState, error) {
	sourceConfig, sourceState := w.Settings, w.loginState
	if prior != nil {
		sourceConfig, sourceState = &prior.Content, prior.loginState
	}
	state := workspaceLoginState{
		Sites: make(map[string]map[string]loginSiteState), Credentials: make(map[string]proposalCredential),
	}
	for _, account := range config.TestAccounts {
		id := stringValue(account.AccountID)
		if err := ensureWorkspaceAccount(ctx, tx, w.ID, id); err != nil {
			return state, err
		}
		state.Sites[id] = make(map[string]loginSiteState, len(account.Sites))
		mayCarryCredentials := false
		for _, site := range account.Sites {
			old, oldScope := accountSite(sourceConfig, id, site.TargetOrigin)
			_, scope := accountSite(config, id, site.TargetOrigin)
			current := sourceState.Sites[id][site.TargetOrigin]
			if old == nil || current.Version == "" || testsAuthenticated(scope) != testsAuthenticated(oldScope) || jsonText(*old) != jsonText(site) {
				current = loginSiteState{Version: NewID()}
			} else if current.Proof == nil {
				current.RunID = nil
			}
			if old != nil && testsAuthenticated(oldScope) && testsAuthenticated(scope) {
				oldOrigin, _ := workspaceURLOrigin(stringValue(old.EntryURL))
				newOrigin, _ := workspaceURLOrigin(stringValue(site.EntryURL))
				mayCarryCredentials = mayCarryCredentials || oldOrigin == newOrigin && oldOrigin != ""
			}
			state.Sites[id][site.TargetOrigin] = current
		}
		if draft, ok := sourceState.Credentials[id]; prior != nil && prior.ScopeConfirmed && ok && mayCarryCredentials {
			official, err := accountCredential(ctx, tx, w.ID, id)
			if err != nil {
				return state, err
			}
			if draft.matchesBase(official) {
				state.Credentials[id] = draft
			}
		}
	}
	return state, nil
}

func promoteWorkspaceLoginState(ctx context.Context, tx *sql.Tx, proposal WorkspaceProposal) (workspaceLoginState, error) {
	formal := workspaceLoginState{Sites: proposal.loginState.Sites}
	for id, draft := range proposal.loginState.Credentials {
		official, err := accountCredential(ctx, tx, proposal.WorkspaceID, id)
		if err != nil {
			return formal, err
		}
		if !draft.matchesBase(official) {
			return formal, ErrConflict
		}
		ref, err := effectiveProposalCredential(ctx, tx, proposal.WorkspaceID, id, &draft)
		if err != nil {
			return formal, err
		}
		proven := false
		for _, site := range formal.Sites[id] {
			proven = proven || site.verified(ref)
		}
		if proven {
			if _, err := tx.ExecContext(ctx, `UPDATE workspace_roles SET secret_ref=$3,secret_version=$4,configured=true WHERE workspace_id=$1 AND id=$2`,
				proposal.WorkspaceID, id, ref.SecretRef, ref.SecretVersion); err != nil {
				return formal, err
			}
		} else if _, err := tx.ExecContext(ctx, `UPDATE workspace_roles SET configured=false WHERE workspace_id=$1 AND id=$2`, proposal.WorkspaceID, id); err != nil {
			return formal, err
		}
		if err := revokeDraftSecret(ctx, tx, proposal.WorkspaceID, id, draft); err != nil {
			return formal, err
		}
		if err := revokeDraftSecret(ctx, tx, proposal.WorkspaceID, id, proposalCredential{SecretRef: official.SecretRef, SecretVersion: official.SecretVersion}); err != nil {
			return formal, err
		}
	}
	for id, sites := range formal.Sites {
		ref, err := accountCredential(ctx, tx, proposal.WorkspaceID, id)
		if err != nil {
			return formal, err
		}
		for target, site := range sites {
			_, scope := accountSite(&proposal.Content, id, target)
			if !site.verified(ref) || !testsAuthenticated(scope) {
				site.Proof, site.RunID = nil, nil
				sites[target] = site
			}
		}
	}
	return formal, nil
}
