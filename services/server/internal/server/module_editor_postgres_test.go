//go:build integration && m12module && m12edit

package server

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func moduleEditWorker(t *testing.T, f moduleCheckpointFixture, pause bool, mode string, reads int) []byte {
	t.Helper()
	a := f.a
	input := map[string]any{"kind": "author", "runId": a.ID, "attemptId": a.AttemptID, "script": a.Script, "timeoutMs": a.TimeoutMS, "workspaceId": a.WorkspaceID, "testId": a.TestID, "workspaceContext": a.WorkspaceContext, "workspaceSettings": a.WorkspaceSettings, "scriptOrigin": a.ScriptOrigin, "author": a.Author}
	command := exec.CommandContext(f.ctx, "node", repositoryFile("scripts", "test", "m12-module-edit-worker.mjs"))
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "TMPDIR=" + os.Getenv("TMPDIR")}
	command.Stdin = strings.NewReader(jsonText(map[string]any{"input": input, "pause": pause, "mode": mode, "readsBefore": reads}))
	var diagnostic bytes.Buffer
	command.Stderr = &diagnostic
	raw, err := command.Output()
	if err != nil {
		t.Fatalf("editor Worker: %v %s", err, diagnostic.String())
	}
	return raw
}

func TestModuleEditorPostgresOneSlotContinuation(t *testing.T) {
	for _, engine := range []string{"builtin", "vercel"} {
		t.Run(engine, func(t *testing.T) {
			f := setupModuleCheckpoint(t, engine)
			mode := "synthetic"
			if engine == "builtin" {
				mode = "real"
			}
			var before string
			if err := f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, f.a.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			// Six explicit, synthetic read requests put the next Run in the original
			// last model slot. No policy is raised or stored receipt rewritten.
			raw := moduleEditWorker(t, f, true, mode, 6)
			f.manager(t, raw)
			r := f.finish(t, raw, "succeeded")
			if r.Status != "succeeded" || r.AuthorPartial == nil || r.AuthorPartial.Usage.ModelRequests != 7 || r.AuthorPartial.Usage.ToolCalls != 7 {
				t.Fatal("checkpoint receipt")
			}
			if err := f.p.ReleaseSlots(f.ctx, "module-checkpoint", nil); err != nil {
				t.Fatal(err)
			}
			s, err := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
			if err != nil {
				t.Fatal(err)
			}
			sub, err := f.p.ContinueAuthor(f.ctx, r.ID, s.ID, s.Draft.Revision)
			if err != nil {
				t.Fatal("one-slot continuation", err)
			}
			a, err := f.p.Claim(f.ctx, "module-checkpoint", 1)
			if err != nil || a == nil || a.ID != sub.Run.ID || a.Author.Budget.MaxModelRequests != 1 || a.Author.Budget.MaxToolCalls != 5 || *a.Author.Runtime != *f.a.Author.Runtime {
				t.Fatal("allocation drift", err)
			}
			f.a = a
			raw = moduleEditWorker(t, f, false, mode, 0)
			f.manager(t, raw)
			done := f.finish(t, raw, "succeeded")
			if done.Status != "succeeded" || done.AuthorPartial != nil {
				t.Fatal("last-slot delivery failed")
			}
			if err = f.p.ReleaseSlots(f.ctx, "module-checkpoint", nil); err != nil {
				t.Fatal(err)
			}
			var count int
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='validation'`, f.item.ID).Scan(&count); err != nil || count != 1 {
				t.Fatal("validation scheduling", err)
			}
			var after string
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, r.ID).Scan(&after); err != nil || after != before {
				t.Fatal("source snapshot mutated", err)
			}
		})
	}
}

func TestModuleEditorPostgresFailedRealSelfTest(t *testing.T) {
	f := setupModuleCheckpoint(t, "builtin")
	before, err := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	raw := moduleEditWorker(t, f, true, "fail", 0)
	var result struct {
		ExpectedFailure   bool `json:"expectedFailure"`
		CheckpointCreated bool `json:"checkpointCreated"`
	}
	if json.Unmarshal(raw, &result) != nil || !result.ExpectedFailure || result.CheckpointCreated {
		t.Fatal("failed candidate promoted")
	}
	if err = f.p.Complete(f.ctx, "module-checkpoint", f.a.ID, f.a.AttemptID, Result{Status: "failed"}); err != nil {
		t.Fatal(err)
	}
	after, err := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
	if err != nil || after.Draft.Revision != before.Draft.Revision || after.Draft.Script != before.Draft.Script || moduleCheckpointHash(after.Draft.Module) != moduleCheckpointHash(before.Draft.Module) {
		t.Fatal("failed editor changed draft", err)
	}
}
