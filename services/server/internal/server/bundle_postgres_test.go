//go:build integration

package server

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestM10PostgresModuleHarnessBundleGate(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "harness")
	if err != nil {
		t.Fatal(err)
	}
	slug := "setup"
	module, err := p.CreatePlatformTest(ctx, w.ID, "setup", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, module.ID)
	if err != nil {
		t.Fatal(err)
	}
	metadata := &Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare", Harness: m10BundleSpec}
	draft, err := p.SavePlatformDraft(ctx, module.ID, session.ID, session.Draft.Revision, m10BundleModule, metadata, nil)
	if err != nil {
		t.Fatal(err)
	}
	run, err := p.ValidateDraft(ctx, module.ID, session.ID, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "m10-bundle", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m10-bundle", 1)
	if err != nil || a == nil || a.ID != run.ID || a.Script != metadata.Harness || len(a.Files) != 2 {
		t.Fatal("harness not dispatched", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET files_snapshot='[]' WHERE id=$1`, run.ID); err == nil {
		t.Fatal("immutable files mutated")
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET bundle_hash=repeat('0',64) WHERE id=$1`, run.ID); err == nil {
		t.Fatal("immutable hash mutated")
	}
	d, err := scanDraft(p.DB.QueryRowContext(ctx, draftSelect, module.ID))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := p.validationProof(ctx, tx, d)
	tx.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	// Only outcome/report availability is synthetic here; all snapshot comparison
	// data comes from the actual persisted validation Run. This does not publish.
	proof.status = "succeeded"
	proof.reportReady = true
	if err := checkPublication(d.Revision, true, d, proof); err != nil {
		t.Fatal("matching bundle gate rejected", err)
	}
	copy := *proof.expectedBundle
	copy.Files = append([]RunFile{}, copy.Files...)
	copy.Files[0].Content += "\n"
	proof.expectedBundle = &copy
	if err := checkPublication(d.Revision, true, d, proof); !errors.Is(err, ErrConflict) {
		t.Fatal("bundle content mismatch passed", err)
	}
	metadataCopy := *metadata
	metadataCopy.Signature = "changed metadata"
	draft, err = p.SavePlatformDraft(ctx, module.ID, session.ID, d.Revision, m10BundleModule, &metadataCopy, nil)
	if err != nil {
		t.Fatal(err)
	}
	if draft.ValidationRunID != nil {
		t.Fatal("metadata edit retained validation")
	}
	replay, err := p.Assignments(ctx, "m10-bundle")
	if err != nil || len(replay) != 1 || jsonText(replay[0].Files) != jsonText(a.Files) {
		t.Fatal("replay reread draft", err)
	}
	if _, err = p.CreateSummary(ctx, module.ID, session.ID, draft.Revision, run.ID); !errors.Is(err, ErrConflict) {
		t.Fatal("unimplemented module summary gate opened", err)
	}
	if _, err = p.Publish(ctx, module.ID, session.ID, draft.Revision, NewID(), true); !errors.Is(err, ErrConflict) {
		t.Fatal("unimplemented publication gate opened", err)
	}
}
func TestM10PostgresUseCasePinnedBundleReplay(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "pinned")
	if err != nil {
		t.Fatal(err)
	}
	slug := "setup"
	module, err := p.CreatePlatformTest(ctx, w.ID, "setup", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	meta := Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare", Harness: m10BundleSpec}
	version := NewID()
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings,module,script_origin) VALUES($1,$2,1,$3,60000,$4,$5,'manual')`, version, module.ID, m10BundleModule, settingsJSON(&w.WorkspaceSettings), jsonText(meta)); err != nil {
		t.Fatal(err)
	}
	usecase, err := p.CreatePlatformTest(ctx, w.ID, "case", "", "usecase", nil)
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, usecase.ID)
	if err != nil {
		t.Fatal(err)
	}
	stages := []Stage{{ID: "prepare", Title: "prepare", Kind: "module", ModuleTestID: module.ID, ModuleVersionID: version, Args: map[string]StageArgument{"value": {Kind: "literal", Value: json.RawMessage(`{"z":1e2,"a":true}`)}}}}
	// Future Compose fixture: persist its generated spec/stages in a new revision;
	// the public Use Case editing/validation endpoints remain closed.
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,stages) SELECT test_id,revision+1,$2,$3,timeout_ms,workspace_settings,workspace_context,'manual',$4 FROM draft_revisions WHERE test_id=$1 AND revision=$5`, usecase.ID, m10BundleSpec, scriptHash(m10BundleSpec), stagesJSON(stages), session.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE drafts SET current_revision=current_revision+1 WHERE test_id=$1`, usecase.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	d, _, err := requireEditingDraft(ctx, tx, usecase.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := bundleForDraft(ctx, tx, d)
	if err != nil {
		t.Fatal(err)
	}
	run, err := enqueueValidationSnapshot(ctx, tx, d, bundle)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	latest := NewID()
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings,module,script_origin) VALUES($1,$2,2,'new version must not replace snapshot',60000,$3,$4,'manual')`, latest, module.ID, settingsJSON(&w.WorkspaceSettings), jsonText(meta)); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, module.ID, latest); err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "m10-pinned", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m10-pinned", 1)
	if err != nil || a == nil || a.ID != run.ID {
		t.Fatal("claim pinned bundle", err)
	}
	if len(a.Files) != 2 || a.Files[0].Content != m10BundleModule {
		t.Fatal("claim followed new version")
	}
	replay, err := p.Assignments(ctx, "m10-pinned")
	if err != nil || len(replay) != 1 || jsonText(replay[0].Files) != jsonText(a.Files) {
		t.Fatal("replay changed files", err)
	}
	if _, err = p.ValidateDraft(ctx, usecase.ID, session.ID, d.Revision); !errors.Is(err, ErrConflict) {
		t.Fatal("Compose gate opened", err)
	}
	// A non-manual dependency taints the whole Run, even with a manual entry.
	ai := NewID()
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings,module,script_origin) VALUES($1,$2,3,$3,60000,$4,$5,'ai')`, ai, module.ID, m10BundleModule, settingsJSON(&w.WorkspaceSettings), jsonText(meta)); err != nil {
		t.Fatal(err)
	}
	d.Stages[0].ModuleVersionID = ai
	tainted, err := bundleForDraft(ctx, p.DB, d)
	if err != nil || tainted.origin() != "ai" {
		t.Fatal("dependency source lost", err)
	}
	tx, err = p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = enqueueValidationSnapshot(ctx, tx, d, tainted)
	tx.Rollback()
	if !errors.Is(err, ErrScopeConfirmation) {
		t.Fatal("AI dependency bypassed scope", err)
	}
}
