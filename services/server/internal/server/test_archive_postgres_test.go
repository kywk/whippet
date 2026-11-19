//go:build integration

package server

import (
	"context"
	"errors"
	"slices"
	"testing"
)

func TestPostgresArchiveKeepsPublishedHistory(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	manualSeedVersions(t, p, ctx)
	const workspace = "00000000-0000-4000-8000-000000000001"
	const id = "10000000-0000-4000-8000-000000000001"
	session, _, err := p.StartEditingSession(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.ArchiveTest(ctx, id); !errors.Is(err, ErrConflict) {
		t.Fatalf("archived a test with an open draft: %v", err)
	}
	if _, err = p.DiscardEditingSession(ctx, id, session.ID, session.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	run, err := p.CreateRun(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = p.ArchiveTest(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	item, err := p.Test(ctx, id)
	if err != nil || !item.Archived || item.Deleted || item.PublishedVersionID == nil {
		t.Fatalf("archived detail: %+v, %v", item, err)
	}
	items, err := p.Tests(ctx, workspace)
	if err != nil || slices.ContainsFunc(items, func(item Test) bool { return item.ID == id }) {
		t.Fatalf("archived test remained in active list: %+v, %v", items, err)
	}
	archived, err := p.ArchivedTests(ctx, workspace)
	if err != nil || len(archived) != 1 || archived[0].ID != id {
		t.Fatalf("archive list: %+v, %v", archived, err)
	}
	if _, err = p.CreateRun(ctx, id); !errors.Is(err, errTestArchived) {
		t.Fatalf("archived test accepted a new Run: %v", err)
	}
	if _, _, err = p.StartEditingSession(ctx, id); !errors.Is(err, errTestArchived) {
		t.Fatalf("archived test accepted a new editing session: %v", err)
	}
	versions, err := p.Versions(ctx, id)
	if err != nil || len(versions) != 2 || versions[0].ID != *item.PublishedVersionID {
		t.Fatalf("published versions missing: %+v, %v", versions, err)
	}
	runs, err := p.Runs(ctx, id)
	if err != nil || len(runs) != 1 || runs[0].ID != run.ID || runs[0].Status != "queued" {
		t.Fatalf("the existing Run changed: %+v, %v", runs, err)
	}
}

func TestPostgresArchivedModuleStillRunsInPinnedUseCase(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.Workspace(ctx, "00000000-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	slug := "archive-fixture"
	module, err := p.CreatePlatformTest(ctx, w.ID, "Archive fixture module", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	usecase, err := p.CreatePlatformTest(ctx, w.ID, "Pinned Use Case", "", "usecase", nil)
	if err != nil {
		t.Fatal(err)
	}
	metadata := Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare", Harness: m10BundleSpec}
	moduleVersion := insertArchiveFixtureVersion(t, ctx, p, w, module.ID, m10BundleModule, &metadata, nil)
	stages := []Stage{{
		ID: "prepare", Title: "Prepare", Kind: "module", ModuleTestID: module.ID, ModuleVersionID: moduleVersion,
	}}
	insertArchiveFixtureVersion(t, ctx, p, w, usecase.ID, m10BundleSpec, nil, stages)
	if catalog, err := p.Catalog(ctx, w.ID); err != nil || len(catalog) != 1 || catalog[0].TestID != module.ID {
		t.Fatalf("published Module missing from Catalog: %+v, %v", catalog, err)
	}
	if err = p.ArchiveTest(ctx, module.ID); err != nil {
		t.Fatal(err)
	}
	if catalog, err := p.Catalog(ctx, w.ID); err != nil || len(catalog) != 0 {
		t.Fatalf("archived Module still in Catalog: %+v, %v", catalog, err)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// The same search is used by the MCP and internal adapter tools.
	found, err := searchToolCatalog(ctx, tx, w.ID, []byte(`{"query":"Archive fixture","limit":20}`))
	if err != nil || len(found.(map[string]any)["items"].([]map[string]any)) != 0 {
		t.Fatalf("archived Module still found by authoring tools: %+v, %v", found, err)
	}
	stagesInput := []PlanStageInput{{
		ID: "prepare", Title: "Prepare", Action: "modify", ModuleVersionID: moduleVersion, Args: map[string]StageArgument{},
	}}
	if _, err = preparePlanStages(ctx, tx, w.ID, stagesInput); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Plan accepted modifying an archived Module: %v", err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	run, err := p.CreateRun(ctx, usecase.ID)
	if err != nil {
		t.Fatalf("published Use Case lost its pinned Module: %v", err)
	}
	if err = p.ArchiveTest(ctx, usecase.ID); err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "archive-verify", 1); err != nil {
		t.Fatal(err)
	}
	assignment, err := p.Claim(ctx, "archive-verify", 1)
	if err != nil || assignment == nil || assignment.ID != run.ID ||
		!slices.ContainsFunc(assignment.Files, func(file RunFile) bool { return file.Path == "lib/"+slug+".ts" }) {
		t.Fatalf("queued Use Case lost its archived dependency: %+v, %v", assignment, err)
	}
}

func TestPostgresArchivedReuseDoesNotBlockStageRetry(t *testing.T) {
	p, ctx, plan, request := retryFixture(t, false)
	pinned := plan.Stages[0]
	if err := p.ArchiveTest(ctx, pinned.ModuleTestID); err != nil {
		t.Fatal(err)
	}
	next, err := p.RetryPlanStage(ctx, plan.ID, "repair", request)
	if err != nil || next.Stages[1].AuthorRunID == nil || next.Stages[0].ModuleVersionID != pinned.ModuleVersionID {
		t.Fatalf("Stage retry lost its archived Module reference: %+v, %v", next, err)
	}
}

func insertArchiveFixtureVersion(t *testing.T, ctx context.Context, p *Postgres, w Workspace, test, script string, module *Module, stages []Stage) string {
	t.Helper()
	session, _, err := p.StartEditingSession(ctx, test)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	bundle, err := bundleForDraft(ctx, tx, draftState{Draft: Draft{
		TestID: test, Script: script, Module: module, Stages: stages, ScriptOrigin: "manual", EditingSessionID: session.ID,
	}})
	if err != nil {
		t.Fatal(err)
	}
	hash, err := bundle.hash()
	if err != nil {
		t.Fatal(err)
	}
	version := NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,script_hash,timeout_ms,
 workspace_settings,script_origin,module,stages,editing_session_id,source_revision,bundle_hash)
 VALUES($1,$2,1,$3,$4,$5,$6,'manual',$7,$8,$9,$10,$11)`,
		version, test, script, scriptHash(script), w.TimeoutMS, settingsJSON(&w.WorkspaceSettings), jsonText(module), stagesJSON(stages), session.ID, session.Draft.Revision, hash); err != nil {
		t.Fatal(err)
	}
	for _, stage := range stages {
		if _, err = tx.ExecContext(ctx, `INSERT INTO version_dependencies(version_id,module_version_id) VALUES($1,$2)`, version, stage.ModuleVersionID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE tests SET published_version_id=$1 WHERE id=$2`, version, test); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET status='published',published_version_id=$1,closed_at=now() WHERE id=$2`, version, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM drafts WHERE test_id=$1`, test); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return version
}
