package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// Called only with the owning Plan locked. Never adopts an existing Module
// editing session, and modify starts from the exact requested version.
func (p *Postgres) dispatchPlanModule(ctx context.Context, tx *sql.Tx, plan *Plan, workspace string, index int) (string, error) {
	if index < 0 || index >= len(plan.Stages) || plan.Status != "running" {
		return "", ErrConflict
	}
	for _, prior := range plan.Stages[:index] {
		if prior.Status != "ready" {
			return "", ErrConflict
		}
	}
	stage := &plan.Stages[index]
	if stage.Status != "pending" || (stage.Action != "create" && stage.Action != "modify") {
		return "", ErrConflict
	}
	test := stage.ModuleTestID
	var source *string
	var script string
	var module *Module
	if stage.Action == "create" {
		if stage.Module == nil {
			return "", ErrInvalid
		}
		test = NewID()
		if _, err := tx.ExecContext(ctx, `INSERT INTO tests(id,workspace_id,name,description,kind,slug) VALUES($1,$2,$3,$4,'module',$3)`, test, workspace, stage.Module.Slug, stage.Module.Description); err != nil {
			return "", dbError(err)
		}
		module = &Module{Slug: stage.Module.Slug, ModuleKind: stage.Module.ModuleKind, ExportName: "run"}
	} else {
		var raw []byte
		if err := tx.QueryRowContext(ctx, `SELECT t.id,v.script,v.module FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.id=$1 AND t.workspace_id=$2 AND t.kind='module'`, stage.ModuleVersionID, workspace).Scan(&test, &script, &raw); err != nil {
			return "", dbError(err)
		}
		if test != stage.ModuleTestID || json.Unmarshal(raw, &module) != nil || module == nil {
			return "", ErrInvalid
		}
		source = &stage.ModuleVersionID
	}
	settings, err := lockEditingTest(ctx, tx, test)
	if err != nil {
		return "", err
	}
	if _, err = readEditing(ctx, tx, test, ""); err == nil {
		return "", ErrConflict
	} else if !errors.Is(err, ErrNotFound) {
		return "", err
	}
	session, conversation := NewID(), NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO editing_sessions(id,test_id,status,source_version_id,conversation_id) VALUES($1,$2,'active',$3,$4)`, session, test, source, conversation); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO conversations(id,test_id,editing_session_id,workspace_id) VALUES($1,$2,$3,$4)`, conversation, test, session, workspace); err != nil {
		return "", err
	}
	contextSnapshot, err := contextForTest(ctx, tx, test)
	if err != nil {
		return "", err
	}
	var revision int
	if err = tx.QueryRowContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,module,stages) SELECT $1,COALESCE(MAX(revision),0)+1,$2,$3,$4,$5,$6,'ai',$7,'[]'::jsonb FROM draft_revisions WHERE test_id=$1 RETURNING revision`, test, script, scriptHash(script), settings.TimeoutMS, settingsJSON(settings), jsonText(contextSnapshot), jsonText(module)).Scan(&revision); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO drafts(test_id,current_revision,editing_session_id) VALUES($1,$2,$3)`, test, revision, session); err != nil {
		return "", err
	}
	d, s, err := requireEditingDraft(ctx, tx, test, session)
	if err != nil {
		return "", err
	}
	message := "Implement this Module for the approved Use Case stage: " + stage.Title
	if stage.Module != nil {
		message += "\n" + stage.Module.Description
	}
	run, err := p.enqueuePlanModuleAuthor(ctx, tx, plan, stage, d, s, message)
	if err != nil {
		return "", err
	}
	stage.ModuleTestID = test
	stage.Status = "authoring"
	stage.DraftRevision = &revision
	stage.AuthorRunID = &run.ID
	if _, err = tx.ExecContext(ctx, `UPDATE plans SET stages=$2 WHERE id=$1`, plan.ID, jsonText(plan.Stages)); err != nil {
		return "", err
	}
	return run.ID, nil
}

func (p *Postgres) enqueuePlanModuleAuthor(ctx context.Context, tx *sql.Tx, plan *Plan, stage *PlanStage, d draftState, s EditingSession, message string) (Run, error) {
	s.ContextRevision++
	input := editingAuthorInput(s, d, "module-authoring", []ChatMessage{{Role: "user", Content: message}})
	input.Platform = &AuthorPlatform{PlanID: &plan.ID, StageID: &stage.ID, Module: d.Module}
	input.AllowedTools = []string{"read_module_draft", "read_validation_report", "update_module_candidate", "request_module_validation"}
	auth, proposal, err := p.prepareAuthor(ctx, tx, d, &input)
	if err != nil {
		return Run{}, err
	}
	if err = snapshotAuthor(&input); err != nil {
		return Run{}, err
	}
	run, err := enqueueAuthorSnapshot(ctx, tx, d, input, Run{authorizationRevision: auth, scopeProposalID: proposal})
	if err != nil {
		return Run{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id,base_revision) VALUES($1,$2,'user',$3,$4,$5)`, NewID(), s.ConversationID, message, run.ID, d.Revision); err != nil {
		return Run{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET context_revision=$2 WHERE id=$1`, s.ID, s.ContextRevision); err != nil {
		return Run{}, err
	}
	return run, nil
}
