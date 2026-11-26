package server

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"time"
)

type siteAIRunBinding struct {
	AgentID       string
	SecretVersion *int
	TokenID       *string
}

func (b siteAIRunBinding) engine() string {
	if b.TokenID != nil {
		return "external"
	}
	return "builtin"
}

func readSiteAIRunBinding(ctx context.Context, q queryDB, workspace, runID string) (*siteAIRunBinding, error) {
	var item siteAIRunBinding
	err := q.QueryRowContext(ctx, `SELECT agent_id,secret_version,token_id FROM site_ai_run_bindings WHERE run_id=$1 AND workspace_id=$2`, runID, workspace).
		Scan(&item.AgentID, &item.SecretVersion, &item.TokenID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &item, err
}

func bindSiteAIAuthor(ctx context.Context, tx *sql.Tx, workspace string, input *AuthorInput, run Run, conn siteAIConnectionView) (*siteAIRunBinding, error) {
	var row *siteAIAgentRow
	var selected *siteAIRunBinding
	if run.chainBudget != nil {
		prior, err := readSiteAIRunBinding(ctx, tx, workspace, run.chainBudget.RootRunID)
		if err != nil || prior == nil {
			return nil, err
		}
		agent, err := readSiteAIAgent(ctx, tx, prior.AgentID, false)
		if err != nil {
			return nil, err
		}
		row, selected = &agent, prior
	} else if run.AuthorEngine == "" {
		var err error
		row, err = siteAIAgentForSkill(ctx, tx, workspace, input.SkillID)
		if err != nil || row == nil {
			return nil, err
		}
		selected = &siteAIRunBinding{AgentID: row.ID, TokenID: row.TokenID}
		if row.ModelKey != nil {
			selected.SecretVersion = row.ModelKey.Version
		}
	}
	if row == nil {
		return nil, nil
	}
	if row.WorkspaceID != workspace {
		return nil, ErrNotFound
	}
	// New admissions report readiness. Continuations still check the pinned credential.
	credentialErr := ErrCredentialUnavailable
	if run.chainBudget == nil {
		credentialErr = errSiteAINotReady
	}
	if selected.SecretVersion != nil {
		if row.ModelKey == nil || row.ModelKey.Version == nil || !row.ModelKey.Configured || *selected.SecretVersion != *row.ModelKey.Version {
			return nil, credentialErr
		}
	} else if selected.TokenID == nil || row.TokenRevoked || stringValue(row.TokenID) != *selected.TokenID {
		return nil, credentialErr
	}
	view := presentSiteAIAgent(*row, conn, time.Now())
	if view.Status != siteAIReady || !slices.Contains(view.Skills, input.SkillID) {
		return nil, errSiteAINotReady
	}
	if row.Mode == siteAIManaged {
		if input.Runtime != nil && input.Runtime.SHA256 != row.Runtime.SHA256 {
			return nil, ErrConflict
		}
		input.Runtime = row.Runtime
	}
	return selected, nil
}

func saveSiteAIRunBinding(ctx context.Context, tx *sql.Tx, workspace, runID string, binding *siteAIRunBinding) error {
	if binding == nil {
		return nil
	}
	return affected(tx.ExecContext(ctx, `INSERT INTO site_ai_run_bindings(run_id,workspace_id,agent_id,secret_version,token_id)
 SELECT id,workspace_id,$3,$4,$5 FROM runs WHERE id=$1 AND workspace_id=$2 AND kind='author'`, runID, workspace, binding.AgentID, binding.SecretVersion, binding.TokenID))
}

func siteAIAssignmentCredential(a *Assignment, version *int) {
	if a.AgentID != nil && version != nil {
		a.modelCredential = &siteAIModelCredential{AgentID: *a.AgentID, SecretVersion: *version}
	}
}
