//go:build integration

package server

import (
	"strings"
	"testing"
)

func TestM10PostgresStandaloneModuleSummary(t *testing.T) {
	for _, mode := range []string{"publish", "metadata_stale", "harness_stale", "body_stale", "metadata_during"} {
		t.Run(mode, func(t *testing.T) { runM10ModuleSummary(t, mode, nil) })
	}
}
func runM10ModuleSummary(t *testing.T, mode string, bridge func(*testing.T, *Postgres, *Assignment, *LocalArtifacts)) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "standalone module")
	if err != nil {
		t.Fatal(err)
	}
	slug := "standalone"
	item, err := p.CreatePlatformTest(ctx, w.ID, "Module", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	metadata := &Module{Slug: slug, ModuleKind: "step", ExportName: "prepare", Harness: "import {test,expect} from '@playwright/test'; import {prepare} from '@lib/standalone'; test('module',async()=>{expect(await prepare({})).toEqual({name:'alpha'});});"}
	body := "export async function prepare(_args:any){return {name:'alpha'};}"
	draft, err := p.SavePlatformDraft(ctx, item.ID, session.ID, session.Draft.Revision, body, metadata, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, NewID()); err == nil {
		t.Fatal("unvalidated module summarized")
	}
	validation, err := p.ValidateDraft(ctx, item.ID, session.ID, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "m10-module-summary", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "m10-module-summary", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	for name, data := range map[string]string{"report.html": "<html>synthetic Module verification</html>", "results.json": `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`} {
		artifact, e := files.Save(a.ID, a.AttemptID, name, strings.NewReader(data))
		if e != nil {
			t.Fatal(e)
		}
		if e = p.SaveArtifact(ctx, artifact); e != nil {
			t.Fatal(e)
		}
	}
	if err = p.Complete(ctx, "m10-module-summary", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if _, err = p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, validation.ID); err == nil {
		t.Fatal("validation not reclaimed")
	}
	if err = p.ReleaseSlots(ctx, "m10-module-summary", nil); err != nil {
		t.Fatal(err)
	}
	summary, err := p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, validation.ID)
	if err != nil {
		t.Fatal(err)
	}
	again, err := p.CreateSummary(ctx, item.ID, session.ID, draft.Revision, validation.ID)
	if err != nil || again.ID != summary.ID {
		t.Fatal("summary duplicate", err)
	}
	a, err = p.Claim(ctx, "m10-module-summary", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	if a.Author.ModuleSummary == nil || a.Author.Batch != nil || a.Author.Platform != nil || a.Author.ValidationEvidence.ScriptHash != scriptHash(metadata.Harness) || a.Author.ModuleSummary.BodyHash != scriptHash(body) {
		t.Fatal("Module summary binding wrong")
	}
	if bridge != nil {
		bridge(t, p, a, files)
	} else {
		artifact, e := files.Save(a.ID, a.AttemptID, "author.json", strings.NewReader(jsonText(summaryOutput{Message: "Module verified", Description: "Module purpose", BackgroundSummary: "Harness verified; synthetic state test"})))
		if e != nil {
			t.Fatal(e)
		}
		if e = p.SaveArtifact(ctx, artifact); e != nil {
			t.Fatal(e)
		}
	}
	if mode == "metadata_during" {
		changed := *metadata
		changed.Signature = "changed during summary"
		if _, err = p.SavePlatformDraft(ctx, item.ID, session.ID, draft.Revision, body, &changed, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err = p.Complete(ctx, "m10-module-summary", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	completed, err := p.Run(ctx, a.ID)
	if mode == "metadata_during" {
		if err != nil || completed.Status != "failed" {
			t.Fatal("stale summary completion accepted", err)
		}
		return
	}
	if err != nil || completed.Status != "succeeded" {
		t.Fatal("summary completion", err)
	}
	if _, err = p.Publish(ctx, item.ID, session.ID, draft.Revision, summary.ID, true); err == nil {
		t.Fatal("summary not reclaimed")
	}
	if err = p.ReleaseSlots(ctx, "m10-module-summary", nil); err != nil {
		t.Fatal(err)
	}
	if mode != "publish" {
		copy := *metadata
		script := body
		switch mode {
		case "metadata_stale":
			copy.Signature = "changed signature"
		case "harness_stale":
			copy.Harness += "\n// changed harness"
		case "body_stale":
			script += "\n// changed body"
		}
		changed, err := p.SavePlatformDraft(ctx, item.ID, session.ID, draft.Revision, script, &copy, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = p.Publish(ctx, item.ID, session.ID, changed.Revision, summary.ID, true); err == nil {
			t.Fatal("stale Module summary published")
		}
		if entries, err := p.Catalog(ctx, w.ID); err != nil || len(entries) != 0 {
			t.Fatal("failed publication leaked Catalog", err)
		}
		return
	}
	published, err := p.Publish(ctx, item.ID, session.ID, draft.Revision, summary.ID, true)
	if err != nil || published.Module == nil || published.Module.Harness != metadata.Harness || published.Script != body {
		t.Fatal("Module publication", err)
	}
	retry, err := p.Publish(ctx, item.ID, session.ID, draft.Revision, summary.ID, true)
	if err != nil || retry.ID != published.ID {
		t.Fatal("publish not idempotent", err)
	}
	if entries, err := p.Catalog(ctx, w.ID); err != nil || len(entries) != 1 || entries[0].VersionID != published.ID {
		t.Fatal("published Module not visible", err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE test_versions SET module='{}' WHERE id=$1`, published.ID); err == nil {
		t.Fatal("version metadata mutable")
	}
	next, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	changed := *metadata
	changed.Harness += "\n// next draft"
	if _, err = p.SavePlatformDraft(ctx, item.ID, next.ID, next.Draft.Revision, body+"\n", &changed, nil); err != nil {
		t.Fatal(err)
	}
	versions, err := p.Versions(ctx, item.ID)
	if err != nil || len(versions) != 1 || versions[0].Script != body || versions[0].Module.Harness != metadata.Harness {
		t.Fatal("published version followed draft", err)
	}
	if _, err = p.CreateRun(ctx, item.ID); err != nil {
		t.Fatal("published Module bundle unavailable", err)
	}
}
