//go:build integration

package server

import (
	"strings"
	"testing"
)

func TestM10PostgresModuleAuthorReclaimValidation(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if e := p.Migrate(ctx); e != nil {
		t.Fatal(e)
	}
	w, e := p.CreateWorkspace(ctx, "module author")
	if e != nil {
		t.Fatal(e)
	}
	config := WorkspaceConfig{Name: "module", Purpose: "synthetic", BackgroundSummary: "synthetic", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://example.test", Purpose: "test"}}}
	if _, e = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, w.ID, jsonText(config)); e != nil {
		t.Fatal(e)
	}
	slug := "setup"
	item, e := p.CreatePlatformTest(ctx, w.ID, "module", "", "module", &slug)
	if e != nil {
		t.Fatal(e)
	}
	session, _, e := p.StartEditingSession(ctx, item.ID)
	if e != nil {
		t.Fatal(e)
	}
	input, _ := m10PlatformInput(t, "module-authoring")
	input.Platform.Module = &Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare"}
	input.AllowedTools = []string{"update_module_candidate", "request_module_validation"}
	tx, e := p.DB.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	d, s, e := requireEditingDraft(ctx, tx, item.ID, session.ID)
	if e != nil {
		t.Fatal(e)
	}
	input.EditingSessionID = s.ID
	input.ConversationID = s.ConversationID
	input.BaseRevision = d.Revision
	input.ContextRevision = s.ContextRevision
	run, e := enqueueAuthorSnapshot(ctx, tx, d, input)
	if e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	if e = p.RegisterManager(ctx, "m10-module", 1); e != nil {
		t.Fatal(e)
	}
	a, e := p.Claim(ctx, "m10-module", 1)
	if e != nil || a == nil || a.ID != run.ID {
		t.Fatal("claim", e)
	}
	files, e := NewLocalArtifacts(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	p.Artifacts = files
	metadata := *input.Platform.Module
	metadata.Harness = m10BundleSpec
	body := jsonText(map[string]any{"message": "self-tested module", "script": m10BundleModule, "module": metadata, "requestValidation": true})
	artifact, e := files.Save(a.ID, a.AttemptID, "author.json", strings.NewReader(body))
	if e != nil {
		t.Fatal(e)
	}
	if e = p.SaveArtifact(ctx, artifact); e != nil {
		t.Fatal(e)
	}
	if e = p.Complete(ctx, "m10-module", a.ID, a.AttemptID, Result{Status: "succeeded"}); e != nil {
		t.Fatal(e)
	}
	completed, e := p.Run(ctx, a.ID)
	if e != nil || completed.Status != "succeeded" {
		t.Fatal("module completion", completed.Status, e)
	}
	var count int
	countValidation := func() int {
		t.Helper()
		if e = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='validation'`, item.ID).Scan(&count); e != nil {
			t.Fatal(e)
		}
		return count
	}
	if countValidation() != 0 {
		t.Fatal("validation before reclaim")
	}
	if e = p.ReleaseSlots(ctx, "m10-module", []ActiveAttempt{{RunID: a.ID, AttemptID: a.AttemptID}}); e != nil {
		t.Fatal(e)
	}
	if countValidation() != 0 {
		t.Fatal("active worker released")
	}
	if e = p.ReleaseSlots(ctx, "m10-module", nil); e != nil {
		t.Fatal(e)
	}
	if countValidation() != 1 {
		t.Fatal("reclaimed module not validated")
	}
	if e = p.ReleaseSlots(ctx, "m10-module", nil); e != nil || countValidation() != 1 {
		t.Fatal("duplicate validation", e)
	}
	validation, e := p.Claim(ctx, "m10-module", 1)
	if e != nil || validation == nil || len(validation.Files) != 2 || validation.Script != m10BundleSpec {
		t.Fatal("module bundle not dispatched", e)
	}
}
