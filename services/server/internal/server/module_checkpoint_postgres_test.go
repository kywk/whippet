//go:build integration && m12module

package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
)

type moduleCheckpointFixture struct {
	p       *Postgres
	ctx     context.Context
	item    Test
	session EditingSession
	a       *Assignment
	files   *LocalArtifacts
}

func setupModuleCheckpoint(t *testing.T, engine string) moduleCheckpointFixture {
	t.Helper()
	m10SkillRoot(t)
	cleanRuntimeEnv(t)
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "module checkpoint")
	if err != nil {
		t.Fatal(err)
	}
	config, err := normalizeConfig(WorkspaceConfig{Name: "checkpoint", Purpose: "synthetic", BackgroundSummary: "synthetic", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://example.test", Purpose: "test"}}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, w.ID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	if engine != "builtin" {
		if _, err = p.SetAgentRuntime(ctx, w.ID, w.Revision, RuntimeSelection{ProfileID: engine, SkillProfiles: map[string]string{}}); err != nil {
			t.Fatal(err)
		}
	}
	slug := "checkpoint"
	item, err := p.CreatePlatformTest(ctx, w.ID, "checkpoint", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	m := &Module{Slug: slug, ModuleKind: "step", ExportName: "run", Harness: "import {test,expect} from '@playwright/test';test('base',()=>{expect(0).toBe(0)});"}
	d, err := p.SavePlatformDraft(ctx, item.ID, s.ID, s.Draft.Revision, "export function run(){return 0}", m, nil)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := p.CreateAuthor(ctx, item.ID, s.ID, "先保存完整且可自試的候選，尚須另一個付款斷言，不發佈", d.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "module-checkpoint", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "module-checkpoint", 1)
	if err != nil || a == nil || a.ID != sub.Run.ID {
		t.Fatal("claim", err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	return moduleCheckpointFixture{p, ctx, item, s, a, files}
}

func (f moduleCheckpointFixture) worker(t *testing.T, pause bool, selfTest ...string) []byte {
	t.Helper()
	a := f.a
	worker := map[string]any{"kind": "author", "runId": a.ID, "attemptId": a.AttemptID, "script": a.Script, "timeoutMs": a.TimeoutMS, "workspaceId": a.WorkspaceID, "testId": a.TestID, "workspaceContext": a.WorkspaceContext, "workspaceSettings": a.WorkspaceSettings, "scriptOrigin": a.ScriptOrigin, "author": a.Author}
	command := exec.CommandContext(f.ctx, "node", repositoryFile("scripts", "test", "m12-module-checkpoint-worker.mjs"))
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "TMPDIR=" + os.Getenv("TMPDIR"), "WHIPPET_SKILLS_PATH=" + repositoryFile("runtimes", "worker", "skills")}
	mode := "synthetic"
	if len(selfTest) > 0 {
		mode = selfTest[0]
	}
	command.Stdin = strings.NewReader(jsonText(map[string]any{"input": worker, "pause": pause, "selfTest": mode}))
	var diagnostic bytes.Buffer
	command.Stderr = &diagnostic
	raw, err := command.Output()
	if err != nil {
		t.Fatalf("synthetic guarded Worker: %v %s", err, diagnostic.String())
	}
	return raw
}

func TestModuleCheckpointPostgresRealSelfTests(t *testing.T) {
	for _, mode := range []string{"pass", "fail"} {
		t.Run(mode, func(t *testing.T) {
			f := setupModuleCheckpoint(t, "builtin")
			before, err := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
			if err != nil {
				t.Fatal(err)
			}
			raw := f.worker(t, true, mode)
			if mode == "pass" {
				r := f.finish(t, raw, "succeeded")
				if r.Status != "succeeded" || r.AuthorPartial == nil || r.AuthorPartial.Checkpoint == nil {
					t.Fatal("real self-test checkpoint not saved")
				}
			} else {
				var result struct {
					ExpectedFailure   bool `json:"expectedFailure"`
					CheckpointCreated bool `json:"checkpointCreated"`
				}
				if json.Unmarshal(raw, &result) != nil || !result.ExpectedFailure || result.CheckpointCreated {
					t.Fatal("failed self-test receipt")
				}
				if err = f.p.Complete(f.ctx, "module-checkpoint", f.a.ID, f.a.AttemptID, Result{Status: "failed"}); err != nil {
					t.Fatal(err)
				}
				after, err := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
				if err != nil || after.Draft.Revision != before.Draft.Revision || after.Draft.Script != before.Draft.Script || moduleCheckpointHash(after.Draft.Module) != moduleCheckpointHash(before.Draft.Module) {
					t.Fatal("failed self-test changed draft", err)
				}
			}
		})
	}
}

func (f moduleCheckpointFixture) finish(t *testing.T, raw []byte, status string) Run {
	t.Helper()
	artifact, err := f.files.Save(f.a.ID, f.a.AttemptID, "author.json", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.p.SaveArtifact(f.ctx, artifact); err != nil {
		t.Fatal(err)
	}
	if err = f.p.Complete(f.ctx, "module-checkpoint", f.a.ID, f.a.AttemptID, Result{Status: status}); err != nil {
		t.Fatal(err)
	}
	r, err := f.p.Run(f.ctx, f.a.ID)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func (f moduleCheckpointFixture) manager(t *testing.T, raw []byte) {
	t.Helper()
	binary := os.Getenv("WHIPPET_M12_MODULE_MANAGER_TEST")
	if binary == "" {
		t.Fatal("build the isolated Manager test binary first")
	}
	command := exec.CommandContext(f.ctx, binary, "-test.run=^TestModuleCheckpointWorkerArtifactBridge$", "-test.v")
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "WHIPPET_M12_MODULE_BRIDGE=1"}
	command.Stdin = strings.NewReader(jsonText(map[string]any{"author": f.a.Author, "script": f.a.Script, "artifact": json.RawMessage(raw)}))
	output, err := command.CombinedOutput()
	if err != nil || strings.Contains(string(output), "SKIP") {
		t.Fatalf("Manager bridge: %v %s", err, output)
	}
}

func TestModuleCheckpointPostgresWorkerContinueAndValidation(t *testing.T) {
	for _, engine := range []string{"builtin", "vercel"} {
		t.Run(engine, func(t *testing.T) {
			f := setupModuleCheckpoint(t, engine)
			var before string
			if err := f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, f.a.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			raw := f.worker(t, true)
			f.manager(t, raw)
			r := f.finish(t, raw, "succeeded")
			if r.Status != "succeeded" || r.AuthorPartial == nil || r.AuthorPartial.Reason != "checkpoint_saved" {
				t.Fatal("partial not saved", r.Status)
			}
			saved, err := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
			if err != nil {
				t.Fatal(err)
			}
			revision := saved.Draft.Revision
			if r.AuthorPartial.AppliedRevision == nil || *r.AuthorPartial.AppliedRevision != revision || r.AuthorPartial.Checkpoint.ModuleHash == nil || *r.AuthorPartial.Checkpoint.ModuleHash != moduleCheckpointHash(saved.Draft.Module) {
				t.Fatal("candidate reference")
			}
			if _, err = f.p.ContinueAuthor(f.ctx, r.ID, f.session.ID, revision); !errors.Is(err, ErrConflict) {
				t.Fatal("continue before reclaim", err)
			}
			if err = f.p.Complete(f.ctx, "module-checkpoint", r.ID, f.a.AttemptID, Result{Status: "succeeded"}); err != nil {
				t.Fatal(err)
			}
			again, _ := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
			if again.Draft.Revision != revision {
				t.Fatal("duplicate result applied twice")
			}
			if err = f.p.ReleaseSlots(f.ctx, "module-checkpoint", nil); err != nil {
				t.Fatal(err)
			}
			var count int
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='validation'`, f.item.ID).Scan(&count); err != nil || count != 0 {
				t.Fatal("partial scheduled validation", err)
			}
			// A later Workspace routing preference must not redirect this trusted chain.
			w, err := f.p.Workspace(f.ctx, f.item.WorkspaceID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.p.SetAuthorEngine(f.ctx, w.ID, w.Revision, "external"); err != nil {
				t.Fatal(err)
			}
			results := make([]AuthorSubmission, 2)
			errs := make([]error, 2)
			var wg sync.WaitGroup
			for i := range results {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					results[i], errs[i] = f.p.ContinueAuthor(f.ctx, r.ID, f.session.ID, revision)
				}(i)
			}
			wg.Wait()
			if errs[0] != nil || errs[1] != nil || results[0].Run.ID != results[1].Run.ID || results[0].Run.AuthorEngine != "builtin" {
				t.Fatal("continue CAS/routing", errs)
			}
			a, err := f.p.Claim(f.ctx, "module-checkpoint", 1)
			if err != nil || a == nil || a.ID != results[0].Run.ID {
				t.Fatal("next claim", err)
			}
			if a.Author.Budget.MaxModelRequests != 5 || a.Author.Budget.MaxToolCalls != 9 || a.Author.Budget.MaxDurationMS != 180000-r.AuthorPartial.Usage.DurationMS || *a.Author.Runtime != *f.a.Author.Runtime || jsonText(a.Author.Skills) != jsonText(f.a.Author.Skills) || a.Script != saved.Draft.Script || moduleCheckpointHash(a.Author.Platform.Module) != *r.AuthorPartial.Checkpoint.ModuleHash {
				t.Fatal("source/budget/runtime drift")
			}
			f.a = a
			completeRaw := f.worker(t, false)
			f.manager(t, completeRaw)
			done := f.finish(t, completeRaw, "succeeded")
			if done.Status != "succeeded" || done.AuthorPartial != nil {
				t.Fatal("second Run incomplete")
			}
			if err = f.p.ReleaseSlots(f.ctx, "module-checkpoint", nil); err != nil {
				t.Fatal(err)
			}
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='validation'`, f.item.ID).Scan(&count); err != nil || count != 1 {
				t.Fatal("formal validation after complete/reclaim", err)
			}
			var after string
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, r.ID).Scan(&after); err != nil || after != before {
				t.Fatal("source payload mutated", err)
			}
			var chainCount int
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM author_continuations WHERE source_run_id=$1`, r.ID).Scan(&chainCount); err != nil || chainCount != 1 {
				t.Fatal("duplicate continuation", err)
			}
		})
	}
}

func TestModuleCheckpointPostgresRejectsStaleCancelledAndExhausted(t *testing.T) {
	for _, mode := range []string{"revision", "context", "authorization", "cancelled", "budget", "insufficient-models", "insufficient-tools", "attempt-cap", "external-output"} {
		t.Run(mode, func(t *testing.T) {
			f := setupModuleCheckpoint(t, "builtin")
			raw := f.worker(t, true)
			if mode == "budget" || mode == "attempt-cap" || strings.HasPrefix(mode, "insufficient-") {
				var out moduleAuthorOutput
				if json.Unmarshal(raw, &out) != nil {
					t.Fatal("fixture")
				}
				out.Partial.Usage = &AuthorUsage{8, 3, 1}
				if mode == "attempt-cap" {
					out.Partial.Usage = &AuthorUsage{1, 1, 1}
				}
				if mode == "insufficient-models" {
					out.Partial.Usage = &AuthorUsage{6, 3, 1}
				}
				if mode == "insufficient-tools" {
					out.Partial.Usage = &AuthorUsage{3, 10, 1}
				}
				raw = []byte(jsonText(out))
			}
			status := "succeeded"
			if mode == "cancelled" {
				status = "cancelled"
			}
			if mode == "external-output" {
				external := NewID()
				if _, err := f.p.DB.ExecContext(f.ctx, `INSERT INTO runs(id,test_id,workspace_id,editing_session_id,kind,status,slot_released,author_payload,draft_revision,script_snapshot,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,author_engine)
 SELECT $2,test_id,workspace_id,editing_session_id,kind,'failed',true,author_payload,draft_revision,script_snapshot,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,'external' FROM runs WHERE id=$1`, f.a.ID, external); err != nil {
					t.Fatal(err)
				}
				token := AgentToken{WorkspaceID: f.item.WorkspaceID}
				if _, err := f.p.validateExternalAuthorSubmission(f.ctx, token, external, raw); !errors.Is(err, ErrInvalid) {
					t.Fatal("external checkpoint preflight accepted", err)
				}
				var normal moduleAuthorOutput
				if json.Unmarshal(raw, &normal) != nil {
					t.Fatal("fixture")
				}
				normal.Partial = nil
				if _, err := f.p.validateExternalAuthorSubmission(f.ctx, token, external, []byte(jsonText(normal))); err != nil {
					t.Fatal("ordinary external Module rejected", err)
				}
				// The external submit path passes output bytes directly; it can never
				// submit the trusted Worker checkpoint envelope.
				err := f.p.completeAuthorWith(f.ctx, f.item.ID, f.a.ID, f.a.AttemptID, Result{Status: "succeeded"}, func(tx *sql.Tx) (string, error) {
					return lockAttempt(f.ctx, tx, "module-checkpoint", f.a.ID, f.a.AttemptID)
				}, raw, nil)
				if err != nil {
					t.Fatal(err)
				}
				r, _ := f.p.Run(f.ctx, f.a.ID)
				if r.Status != "failed" || r.AuthorPartial != nil {
					t.Fatal("external trusted checkpoint")
				}
				return
			}
			r := f.finish(t, raw, status)
			if err := f.p.ReleaseSlots(f.ctx, "module-checkpoint", nil); err != nil {
				t.Fatal(err)
			}
			s, err := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
			if err != nil {
				t.Fatal(err)
			}
			revision := s.Draft.Revision
			switch mode {
			case "revision":
				if _, err = f.p.SavePlatformDraft(f.ctx, f.item.ID, s.ID, revision, s.Draft.Script+"// manual", s.Draft.Module, nil); err != nil {
					t.Fatal(err)
				}
			case "context":
				_, err = f.p.DB.ExecContext(f.ctx, `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=$1`, s.ID)
			case "authorization":
				_, err = f.p.DB.ExecContext(f.ctx, `UPDATE workspaces SET authorization_revision=authorization_revision+1 WHERE id=$1`, f.item.WorkspaceID)
			case "attempt-cap":
				for i := 1; i < 3; i++ {
					sub, e := f.p.ContinueAuthor(f.ctx, r.ID, s.ID, revision)
					if e != nil {
						t.Fatal(e)
					}
					a, e := f.p.Claim(f.ctx, "module-checkpoint", 1)
					if e != nil || a == nil || a.ID != sub.Run.ID {
						t.Fatal("claim", e)
					}
					f.a = a
					r = f.finish(t, raw, "succeeded")
					if err = f.p.ReleaseSlots(f.ctx, "module-checkpoint", nil); err != nil {
						t.Fatal(err)
					}
					s, e = f.p.EditingSession(f.ctx, f.item.ID, s.ID)
					if e != nil {
						t.Fatal(e)
					}
					revision = s.Draft.Revision
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			var before int
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM runs WHERE test_id=$1`, f.item.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			_, err = f.p.ContinueAuthor(f.ctx, r.ID, s.ID, revision)
			if mode == "budget" || mode == "attempt-cap" || strings.HasPrefix(mode, "insufficient-") {
				if !errors.Is(err, ErrContinuationBudget) {
					t.Fatal("budget reset", err)
				}
			} else if err == nil {
				t.Fatal("stale/cancelled source continued")
			}
			var after int
			if e := f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM runs WHERE test_id=$1`, f.item.ID).Scan(&after); e != nil || before != after {
				t.Fatal("rejected continuation left Run", e)
			}
		})
	}
}
