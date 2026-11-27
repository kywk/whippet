package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"unicode/utf8"
)

type workspaceAuthorOutput struct {
	Message             string           `json:"message"`
	Proposal            *WorkspaceConfig `json:"proposal,omitempty"`
	ConversationSummary *string          `json:"conversationSummary,omitempty"`
}

func decodeWorkspaceAuthorOutput(data []byte) (workspaceAuthorOutput, error) {
	var out workspaceAuthorOutput
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if len(data) > int(MaxAuthorArtifactBytes) || !utf8.Valid(data) || strictJSONNoDuplicates(data) != nil || dec.Decode(&out) != nil || dec.Decode(new(any)) != io.EOF || validateUserMessage(out.Message) != nil ||
		(out.ConversationSummary != nil && !configText(*out.ConversationSummary, 8192)) {
		return out, fmt.Errorf("invalid Workspace author output")
	}
	fields, ok := workspaceJSONFields(data, "message", "proposal", "conversationSummary")
	if !ok {
		return out, configError()
	}
	if out.Proposal != nil {
		if !validWorkspaceProposalFields(fields["proposal"]) {
			return out, configError()
		}
		c, err := normalizeConfig(*out.Proposal, false)
		if err != nil {
			return out, err
		}
		setWorkspaceTestDefaults(&c)
		out.Proposal = &c
	}
	return out, nil
}

func readWorkspaceConversation(ctx context.Context, q queryDB, id string) (WorkspaceConversation, error) {
	c := WorkspaceConversation{WorkspaceID: id, OwnerType: "workspace", Messages: []Message{}}
	err := q.QueryRowContext(ctx, `SELECT c.id,c.context_revision,c.conversation_summary,
 (SELECT r.id FROM runs r WHERE r.workspace_id=c.workspace_id AND r.test_id IS NULL AND r.kind='author' AND r.status IN ('queued','dispatched','running','collecting','cancelling'))
 FROM conversations c WHERE c.workspace_id=$1 AND c.owner_type='workspace'`, id).Scan(&c.ID, &c.ContextRevision, &c.ConversationSummary, &c.ActiveRunID)
	if err != nil {
		return c, dbError(err)
	}
	rows, err := q.QueryContext(ctx, `SELECT id,role,content,created_at,run_id FROM messages WHERE conversation_id=$1 ORDER BY sequence`, c.ID)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Role, &m.Content, &m.CreatedAt, &m.RunID); err != nil {
			return c, err
		}
		m.CreatedAt = m.CreatedAt.UTC()
		c.Messages = append(c.Messages, m)
	}
	return c, rows.Err()
}
func (p *Postgres) WorkspaceConversation(ctx context.Context, id string) (WorkspaceConversation, error) {
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return WorkspaceConversation{}, err
	}
	defer tx.Rollback()
	c, err := readWorkspaceConversation(ctx, tx, id)
	if err != nil {
		return c, err
	}
	if err = tx.Commit(); err != nil {
		return c, err
	}
	return c, nil
}
func (p *Postgres) CreateWorkspaceAuthor(ctx context.Context, id, content string, revision int, contextRevision int64) (AuthorSubmission, error) {
	if err := validateUserMessage(content); err != nil {
		return AuthorSubmission{}, err
	}
	if contextRevision < 0 {
		return AuthorSubmission{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return AuthorSubmission{}, err
	}
	defer tx.Rollback()
	w, pid, err := lockWorkspaceSettings(ctx, tx, id)
	if err != nil {
		return AuthorSubmission{}, err
	}
	if err := w.Management.State.workError(); err != nil {
		return AuthorSubmission{}, err
	}
	if err = checkRevision(revision, w.Revision); err != nil {
		return AuthorSubmission{}, err
	}
	w, err = fillWorkspace(ctx, tx, w, pid, p.Secrets != nil, p.CredentialTLS)
	if err != nil {
		return AuthorSubmission{}, err
	}
	c, err := readWorkspaceConversation(ctx, tx, id)
	if err != nil {
		return AuthorSubmission{}, err
	}
	if c.ContextRevision != contextRevision || c.ActiveRunID != nil {
		return AuthorSubmission{}, ErrConflict
	}
	newest := []ChatMessage{{Role: "user", Content: content}}
	for i := len(c.Messages) - 1; i >= 0 && len(newest) < 12; i-- {
		newest = append(newest, ChatMessage{Role: c.Messages[i].Role, Content: c.Messages[i].Content})
	}
	input := AuthorInput{SkillID: "workspace-author", SkillVersion: "1", AllowedTools: []string{}, ConversationID: c.ID, BaseRevision: w.Revision, ContextRevision: contextRevision + 1,
		SourceVersion: nil, ConversationSummary: c.ConversationSummary, Messages: authorContext(newest)}
	if previous := w.CurrentProposal; previous != nil {
		input.WorkspaceProposal = &WorkspaceInterviewProposal{Content: previous.Content, SiteReadiness: previous.SiteReadiness}
	}
	if err = p.checkAuthorIntent(ctx, input.SkillID, input.Messages); err != nil {
		return AuthorSubmission{}, err
	}
	input.History, err = conversationHistorySnapshot(ctx, tx, c.ID)
	if err != nil {
		return AuthorSubmission{}, err
	}
	input.AllowedTools = append(input.AllowedTools, "read_conversation_history")
	snapshot, scopeProposal := selectedContext(w, true)
	var authorization *int64
	if snapshot.Config != nil {
		rev := w.AuthorizationRevision
		authorization = &rev
		input.AllowedTools = append(input.AllowedTools, browserTools...)
		if p.Secrets != nil && p.CredentialTLS {
			input.AllowedTools = append(input.AllowedTools, "browser_login")
		}
	}
	if err = snapshotAuthor(&input); err != nil {
		return AuthorSubmission{}, err
	}
	selected, err := bindSiteAIAuthor(ctx, tx, id, &input, Run{}, p.siteAIConnection())
	if err != nil {
		return AuthorSubmission{}, err
	}
	engine := w.AuthorEngine
	if selected != nil {
		engine = selected.engine()
	} else if err = snapshotRuntime(ctx, tx, id, &input); err != nil {
		return AuthorSubmission{}, err
	}
	runID := NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO runs(id,workspace_id,test_id,kind,script_snapshot,script_hash,timeout_ms,author_payload,workspace_settings,workspace_context,script_origin,authorization_revision,scope_proposal_id,author_engine,author_intent_checked)
 VALUES($1,$2,NULL,'author','',$3,$4,$5,$6,$7,'legacy',$8,$9,$10,true)`, runID, id, scriptHash(""), input.Budget.MaxDurationMS, jsonText(input), settingsJSON(&w.WorkspaceSettings), jsonText(snapshot), authorization, scopeProposal, engine); err != nil {
		return AuthorSubmission{}, err
	}
	if err = saveSiteAIRunBinding(ctx, tx, id, runID, selected); err != nil {
		return AuthorSubmission{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id) VALUES($1,$2,'user',$3,$4)`, NewID(), c.ID, content, runID); err != nil {
		return AuthorSubmission{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE conversations SET context_revision=context_revision+1 WHERE id=$1`, c.ID); err != nil {
		return AuthorSubmission{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_proposals SET status='stale',invalidation_reason='context_changed' WHERE workspace_id=$1 AND status='pending'`, id); err != nil {
		return AuthorSubmission{}, err
	}
	run, err := scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1`, runID))
	if err != nil {
		return AuthorSubmission{}, err
	}
	if err = tx.Commit(); err != nil {
		return AuthorSubmission{}, err
	}
	return AuthorSubmission{Run: run, ConversationID: c.ID}, nil
}

func retainLegacyWorkspaceRoles(w Workspace, proposal *WorkspaceConfig) {
	source := w.Settings
	if previous := w.CurrentProposal; source == nil && previous != nil && previous.BaseRevision == w.Revision &&
		(previous.Status == "pending" || previous.Status == "stale" && stringValue(previous.InvalidationReason) == "context_changed") {
		source = &previous.Content
	}
	proposal.LoginRoles = []WorkspaceRole{}
	if source != nil {
		for _, role := range source.LoginRoles {
			if role.RoleID != nil && loginOriginAllowed(proposal, role.LoginOrigin) {
				proposal.LoginRoles = append(proposal.LoginRoles, role)
			}
		}
	}
}

func (p *Postgres) completeWorkspaceAuthor(ctx context.Context, workspaceID, managerID, runID, attemptID string, incoming Result) error {
	return p.completeWorkspaceAuthorWith(ctx, workspaceID, runID, attemptID, incoming,
		func(tx *sql.Tx) (string, error) { return lockAttempt(ctx, tx, managerID, runID, attemptID) }, nil, nil)
}

func (p *Postgres) completeWorkspaceAuthorWith(ctx context.Context, workspaceID, runID, attemptID string, incoming Result,
	lock func(*sql.Tx) (string, error), externalOutput []byte, finish func(*sql.Tx) error) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	w, pid, err := readWorkspaceCore(ctx, tx, workspaceID, true)
	if err != nil {
		return err
	}
	w, err = fillWorkspace(ctx, tx, w, pid, p.Secrets != nil, p.CredentialTLS)
	if err != nil {
		return err
	}
	status, err := lock(tx)
	if err != nil {
		return err
	}
	var reported sql.NullString
	var raw []byte
	if err = tx.QueryRowContext(ctx, `SELECT author_reported_status,author_payload FROM runs WHERE id=$1 AND workspace_id=$2 AND test_id IS NULL`, runID, workspaceID).Scan(&reported, &raw); err != nil {
		return err
	}
	result, duplicate, err := authorResultDisposition(status, reported.String, incoming)
	if err != nil || duplicate {
		return err
	}
	if result.Status == "succeeded" {
		var input AuthorInput
		c, err := readWorkspaceConversation(ctx, tx, workspaceID)
		if err != nil {
			return err
		}
		if json.Unmarshal(raw, &input) != nil || input.SkillID != "workspace-author" || input.SkillVersion != "1" || !workspaceAuthorToolsValid(input.AllowedTools) || input.EditingSessionID != "" || input.SourceVersion != nil || input.ConversationID != c.ID {
			result = Result{Status: "failed", Error: "Workspace interview input was invalid."}
		} else if hasBrowserTools(&input) && !workspaceRunScopeValid(ctx, tx, w, runID) {
			result = Result{Status: "failed", Error: "scope_confirmation_required: the interview scope was revoked."}
		} else if input.BaseRevision != w.Revision || input.ContextRevision != c.ContextRevision {
			result = Result{Status: "failed", Error: "Workspace settings or conversation changed; this result was not applied."}
		} else {
			data, outputErr := externalOutput, error(nil)
			if data == nil {
				data, outputErr = p.readArtifactBytes(ctx, tx, runID, attemptID, "author.json", MaxAuthorArtifactBytes)
			}
			var output workspaceAuthorOutput
			if outputErr == nil {
				output, outputErr = decodeWorkspaceAuthorOutput(data)
			}
			if outputErr == nil && output.Proposal != nil {
				retainLegacyWorkspaceRoles(w, output.Proposal)
				outputErr = assignWorkspaceTestAccounts(output.Proposal, input.WorkspaceProposal)
			}
			if outputErr != nil {
				result = Result{Status: "failed", Error: "Workspace interview output was invalid; saved settings are unchanged."}
			} else {
				nextContext := c.ContextRevision + 1
				if _, err = tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id) VALUES($1,$2,'assistant',$3,$4)`, NewID(), c.ID, output.Message, runID); err != nil {
					return err
				}
				if _, err = tx.ExecContext(ctx, `UPDATE conversations SET context_revision=$2,conversation_summary=COALESCE($3,conversation_summary) WHERE id=$1`, c.ID, nextContext, output.ConversationSummary); err != nil {
					return err
				}
				if output.Proposal != nil {
					proposalID := NewID()
					hash := workspaceScopeHash(*output.Proposal)
					confirmed := (w.Settings != nil && workspaceScopeHash(*w.Settings) == hash && w.ScopeStatus == "confirmed") || (w.CurrentProposal != nil && w.CurrentProposal.ScopeConfirmed && w.CurrentProposal.ScopeHash == hash && (w.CurrentProposal.Status == "pending" || w.CurrentProposal.Status == "applied" || (w.CurrentProposal.Status == "stale" && stringValue(w.CurrentProposal.InvalidationReason) == "context_changed")))
					if previous := w.CurrentProposal; previous != nil && previous.ScopeConfirmed && previous.ScopeHash != hash {
						if err = cancelScopedRuns(ctx, tx, workspaceID, runID, &previous.ID); err != nil {
							return err
						}
					}
					if _, err = tx.ExecContext(ctx, `UPDATE workspace_proposals SET status='superseded',invalidation_reason='superseded' WHERE workspace_id=$1 AND status='pending'`, workspaceID); err != nil {
						return err
					}
					if _, err = tx.ExecContext(ctx, `INSERT INTO workspace_proposals(id,workspace_id,conversation_id,source_run_id,base_revision,context_revision,status,content,scope_hash,scope_confirmed)
 VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)`, proposalID, workspaceID, c.ID, runID, w.Revision, nextContext, jsonText(output.Proposal), hash, confirmed); err != nil {
						return err
					}
					if _, err = tx.ExecContext(ctx, `UPDATE workspaces SET current_proposal_id=$2,scope_status=CASE WHEN canonical_config IS NULL THEN $3 ELSE scope_status END WHERE id=$1`, workspaceID, proposalID, map[bool]string{true: "confirmed", false: "unconfirmed"}[confirmed]); err != nil {
						return err
					}
				}
			}
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET status=$2,error=$3,finished_at=now(),author_reported_status=$4,acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1`, runID, result.Status, result.Error, incoming.Status); err != nil {
		return err
	}
	if finish != nil {
		if err = finish(tx); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (p *Postgres) ActWorkspaceProposal(ctx context.Context, id, proposalID, action string, base int) (Workspace, WorkspaceProposal, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Workspace{}, WorkspaceProposal{}, err
	}
	defer tx.Rollback()
	w, pid, err := lockWorkspaceSettings(ctx, tx, id)
	if err != nil {
		return w, WorkspaceProposal{}, err
	}
	if action != "cancel" {
		if err := w.Management.State.workError(); err != nil {
			return w, WorkspaceProposal{}, err
		}
	}
	proposal, err := readProposal(ctx, tx, id, proposalID, true)
	if err != nil {
		return w, proposal, err
	}
	if (action == "confirm" && proposal.Status == "applied") || (action == "cancel" && proposal.Status == "cancelled") {
		w, err = fillWorkspace(ctx, tx, w, pid, p.Secrets != nil, p.CredentialTLS)
		return w, proposal, err
	}
	if proposal.Status != "pending" {
		return w, proposal, ErrConflict
	}
	var currentContext int64
	if err = tx.QueryRowContext(ctx, `SELECT context_revision FROM conversations WHERE id=$1 AND workspace_id=$2 AND owner_type='workspace'`, proposal.ConversationID, id).Scan(&currentContext); err != nil {
		return w, proposal, err
	}
	if base != proposal.BaseRevision || base != w.Revision || currentContext != proposal.ContextRevision || pid == nil || *pid != proposal.ID {
		reason := "context_changed"
		if base != w.Revision || base != proposal.BaseRevision {
			reason = "base_revision_changed"
		}
		if _, err = tx.ExecContext(ctx, `UPDATE workspace_proposals SET status='stale',invalidation_reason=$2 WHERE id=$1`, proposal.ID, reason); err != nil {
			return w, proposal, err
		}
		if err = tx.Commit(); err != nil {
			return w, proposal, err
		}
		return w, proposal, ErrConflict
	}
	switch action {
	case "confirm-scope":
		if len(proposal.Content.Targets) == 0 {
			return w, proposal, configError()
		}
		if !proposal.ScopeConfirmed {
			if _, err = tx.ExecContext(ctx, `UPDATE workspace_proposals SET scope_confirmed=true WHERE id=$1`, proposal.ID); err != nil {
				return w, proposal, err
			}
			if _, err = tx.ExecContext(ctx, `UPDATE workspaces SET scope_status='confirmed',authorization_revision=authorization_revision+1 WHERE id=$1 AND canonical_config IS NULL`, id); err != nil {
				return w, proposal, err
			}
		}
	case "cancel":
		if err = cancelScopedRuns(ctx, tx, id, "", &proposal.ID); err != nil {
			return w, proposal, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE workspace_proposals SET status='cancelled',scope_confirmed=false,invalidation_reason='cancelled' WHERE id=$1`, proposal.ID); err != nil {
			return w, proposal, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE workspaces SET scope_status='unconfirmed',authorization_revision=authorization_revision+1 WHERE id=$1 AND canonical_config IS NULL`, id); err != nil {
			return w, proposal, err
		}
	case "confirm":
		config, err := normalizeConfig(proposal.Content, true)
		if err != nil {
			return w, proposal, err
		}
		for _, site := range proposal.SiteReadiness {
			if !site.Ready {
				return w, proposal, ErrWorkspaceSetupIncomplete
			}
		}
		changed := w.Settings == nil || jsonText(w.Settings) != jsonText(config) || w.Lifecycle != "active"
		if changed {
			if w.Settings != nil && workspaceScopeHash(*w.Settings) != workspaceScopeHash(config) {
				if err = cancelScopedRuns(ctx, tx, id, "", nil); err != nil {
					return w, proposal, err
				}
			}
			w.Revision++
			projection := WorkspaceSettings{Revision: w.Revision, Sites: []WorkspaceSite{}, DefaultTestURL: config.DefaultTestURL, TimeoutMS: config.TimeoutMS}
			for _, target := range config.Targets {
				projection.Sites = append(projection.Sites, WorkspaceSite{Name: target.Name, URL: target.Origin})
			}
			if _, err = tx.ExecContext(ctx, `UPDATE workspaces SET name=$2,settings=$3,canonical_config=$4,lifecycle='active',scope_status='confirmed',authorization_revision=authorization_revision+1 WHERE id=$1`, id, config.Name, settingsJSON(&projection), jsonText(config)); err != nil {
				return w, proposal, err
			}
			if err = refreshWorkspaceDrafts(ctx, tx, id, p.Secrets != nil); err != nil {
				return w, proposal, err
			}
		}
		if _, err = tx.ExecContext(ctx, `UPDATE workspace_proposals SET status='applied',scope_confirmed=true,applied_revision=$2 WHERE id=$1`, proposal.ID, w.Revision); err != nil {
			return w, proposal, err
		}
	default:
		return w, proposal, ErrInvalid
	}
	w, pid, err = readWorkspaceCore(ctx, tx, id, false)
	if err != nil {
		return w, proposal, err
	}
	w, err = fillWorkspace(ctx, tx, w, pid, p.Secrets != nil, p.CredentialTLS)
	if err != nil {
		return w, proposal, err
	}
	proposal, err = readProposal(ctx, tx, id, proposalID, false)
	if err != nil {
		return w, proposal, err
	}
	if err = tx.Commit(); err != nil {
		return w, proposal, err
	}
	return w, proposal, nil
}

func refreshWorkspaceDrafts(ctx context.Context, tx *sql.Tx, id string, secrets bool) error {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM tests WHERE workspace_id=$1 ORDER BY id FOR UPDATE`, id)
	if err != nil {
		return err
	}
	for rows.Next() {
		var testID string
		if err = rows.Scan(&testID); err != nil {
			rows.Close()
			return err
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	w, pid, err := readWorkspaceCore(ctx, tx, id, false)
	if err != nil {
		return err
	}
	w, err = fillWorkspace(ctx, tx, w, pid, secrets)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,module,stages)
 SELECT dr.test_id,dr.revision+1,dr.script,dr.script_hash,$2,$3,$4,dr.script_origin,dr.module,dr.stages FROM drafts d JOIN tests t ON t.id=d.test_id
 JOIN draft_revisions dr ON dr.test_id=d.test_id AND dr.revision=d.current_revision JOIN editing_sessions e ON e.id=d.editing_session_id
 WHERE t.workspace_id=$1 AND e.status='active'`, id, w.TimeoutMS, settingsJSON(&w.WorkspaceSettings), jsonText(workspaceContext(w))); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE drafts d SET current_revision=current_revision+1,validation_run_id=NULL,summary_run_id=NULL,summary_description=NULL,summary_background=NULL,summary_name=NULL,summary_suggested_tags=DEFAULT,updated_at=now()
 FROM tests t,editing_sessions e WHERE d.test_id=t.id AND t.workspace_id=$1 AND e.id=d.editing_session_id AND e.status='active'`, id)
	return err
}
