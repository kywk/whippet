//go:build integration

package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type m10PartialFixture struct {
	p                 *Postgres
	ctx               context.Context
	assignment        *Assignment
	testID, sessionID string
	revision          int
	files             *LocalArtifacts
}

func setupM10Partial(t *testing.T) m10PartialFixture {
	t.Helper()
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	w, err := p.CreateWorkspace(ctx, "partial")
	if err != nil {
		t.Fatal(err)
	}
	test, err := p.CreateTest(ctx, w.ID, "partial", "")
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	d, err := p.SaveDraft(ctx, test.ID, s.ID, s.Draft.Revision, "old script")
	if err != nil {
		t.Fatal(err)
	}
	sub, err := p.CreateAuthor(ctx, test.ID, s.ID, "write assertions", d.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "m10-partial", 1); err != nil {
		t.Fatal(err)
	}
	assignment, err := p.Claim(ctx, "m10-partial", 1)
	if err != nil || assignment == nil || assignment.ID != sub.Run.ID {
		t.Fatal("claim", err)
	}
	return m10PartialFixture{p, ctx, assignment, test.ID, s.ID, d.Revision, files}
}
func (f m10PartialFixture) finish(t *testing.T, script *string, status string) {
	t.Helper()
	output := authorOutput{Message: stringPointer("budget exhausted"), RequestValidation: new(bool), Script: script, Partial: &AuthorPartialOutput{Reason: "budget_exhausted", NextStep: "finish remaining assertions"}}
	if script != nil {
		output.Partial.Checkpoint = &AuthorCheckpoint{ScriptHash: scriptHash(*script), SelfTestPassed: true}
	}
	body := jsonText(output)
	artifact, err := f.files.Save(f.assignment.ID, f.assignment.AttemptID, "author.json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.p.SaveArtifact(f.ctx, artifact); err != nil {
		t.Fatal(err)
	}
	if err = f.p.Complete(f.ctx, "m10-partial", f.assignment.ID, f.assignment.AttemptID, Result{Status: status}); err != nil {
		t.Fatal(err)
	}
}
func TestM10PostgresPartialPersistenceAndContinueCAS(t *testing.T) {
	m10SkillRoot(t)
	for _, checkpoint := range []bool{false, true} {
		name := "without_checkpoint"
		if checkpoint {
			name = "with_checkpoint"
		}
		t.Run(name, func(t *testing.T) {
			f := setupM10Partial(t)
			var script *string
			if checkpoint {
				script = stringPointer("verified candidate")
			}
			f.finish(t, script, "succeeded")
			run, err := f.p.Run(f.ctx, f.assignment.ID)
			if err != nil || run.Status != "succeeded" || run.AuthorPartial == nil {
				t.Fatal("partial not persisted", err)
			}
			expected := f.revision
			if checkpoint {
				expected++
				if run.AuthorPartial.AppliedRevision == nil || *run.AuthorPartial.AppliedRevision != expected {
					t.Fatal("applied revision missing")
				}
			} else if run.AuthorPartial.AppliedRevision != nil {
				t.Fatal("no checkpoint advanced revision")
			}
			if _, err := f.p.ContinueAuthor(f.ctx, run.ID, f.sessionID, expected); !errors.Is(err, ErrConflict) {
				t.Fatal("continued before Worker reclaimed", err)
			}
			if err = f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
				t.Fatal(err)
			}
			// Concurrent duplicate UI actions must resolve to a single committed Run.
			var wg sync.WaitGroup
			results := make([]AuthorSubmission, 2)
			errs := make([]error, 2)
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					results[i], errs[i] = f.p.ContinueAuthor(f.ctx, run.ID, f.sessionID, expected)
				}(i)
			}
			wg.Wait()
			if errs[0] != nil || errs[1] != nil || results[0].Run.ID != results[1].Run.ID {
				t.Fatalf("duplicate continuation: %v %v", errs[0], errs[1])
			}
			var childPayload []byte
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload FROM runs WHERE id=$1`, results[0].Run.ID).Scan(&childPayload); err != nil {
				t.Fatal(err)
			}
			var childInput AuthorInput
			if err = json.Unmarshal(childPayload, &childInput); err != nil {
				t.Fatal(err)
			}
			allowed := map[string]bool{}
			for _, tool := range f.assignment.Author.AllowedTools {
				allowed[tool] = true
			}
			for _, tool := range childInput.AllowedTools {
				if !allowed[tool] {
					t.Fatal("continuation expanded capabilities", tool)
				}
			}
			if _, err := f.p.ContinueAuthor(f.ctx, run.ID, f.sessionID, expected+1); !errors.Is(err, ErrConflict) {
				t.Fatal("different retry body accepted", err)
			}
			if _, err := f.p.ContinueAuthor(f.ctx, run.ID, NewID(), expected); !errors.Is(err, ErrConflict) {
				t.Fatal("different session accepted", err)
			}
			var count int
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM author_continuations WHERE source_run_id=$1`, run.ID).Scan(&count); err != nil || count != 1 {
				t.Fatal("duplicate relation", err)
			}
			if err = f.p.Complete(f.ctx, "m10-partial", run.ID, f.assignment.AttemptID, Result{Status: "succeeded"}); err != nil {
				t.Fatal("result replay", err)
			}
			// HTTP retains body strictness and returns the same Run, despite moved context.
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			engine := NewEngine(f.p, log)
			defer engine.Close()
			handler := NewAPI(f.p, f.files, engine, "token", log).Handler(nil)
			request := httptest.NewRequest("POST", "http://server/api/runs/"+run.ID+"/continue", strings.NewReader(jsonText(map[string]any{"editingSessionId": f.sessionID, "revision": expected})))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			var body AuthorSubmission
			if response.Code != 202 || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Run.ID != results[0].Run.ID {
				t.Fatalf("HTTP continuation retry %d", response.Code)
			}
			request = httptest.NewRequest("POST", "http://server/api/runs/"+run.ID+"/continue", strings.NewReader(jsonText(map[string]any{"editingSessionId": f.sessionID, "revision": expected, "contextRevision": 1})))
			response = httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != 400 {
				t.Fatal("unknown continuation field accepted")
			}
		})
	}
}
func TestM10PostgresPartialStaleAndCancelled(t *testing.T) {
	m10SkillRoot(t)
	for _, mode := range []string{"revision_before_completion", "context_before_completion", "revision_after_completion", "context_after_completion", "cancelled", "timed_out"} {
		t.Run(mode, func(t *testing.T) {
			f := setupM10Partial(t)
			changeRevision := func() {
				if _, err := f.p.SaveDraft(f.ctx, f.testID, f.sessionID, f.revision, "manual concurrent edit"); err != nil {
					t.Fatal(err)
				}
			}
			changeContext := func() {
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=$1`, f.sessionID); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "revision_before_completion" {
				changeRevision()
			}
			if mode == "context_before_completion" {
				changeContext()
			}
			status := "succeeded"
			if mode == "cancelled" || mode == "timed_out" {
				status = mode
			}
			var candidate *string
			if mode == "revision_before_completion" || mode == "context_before_completion" {
				candidate = stringPointer("must remain proposal")
			}
			f.finish(t, candidate, status)
			if mode == "revision_after_completion" {
				changeRevision()
			}
			if mode == "context_after_completion" {
				changeContext()
			}
			if err := f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
				t.Fatal(err)
			}
			if _, err := f.p.ContinueAuthor(f.ctx, f.assignment.ID, f.sessionID, f.revision); !errors.Is(err, ErrConflict) {
				t.Fatal("stale/cancelled continuation accepted", err)
			}
			run, err := f.p.Run(f.ctx, f.assignment.ID)
			if err != nil {
				t.Fatal(err)
			}
			if candidate != nil {
				draft, err := f.p.Draft(f.ctx, f.testID)
				if err != nil {
					t.Fatal(err)
				}
				if draft.Script == *candidate || run.AuthorPartial == nil || run.AuthorPartial.AppliedRevision != nil {
					t.Fatal("stale checkpoint applied")
				}
			}
			if status != "succeeded" && run.AuthorPartial != nil {
				t.Fatal("cancel/timeout misreported as partial")
			}
		})
	}
}

func TestM10PostgresPartialInvalidCheckpointNoMutation(t *testing.T) {
	m10SkillRoot(t)
	for _, body := range []string{
		`{"message":"m","requestValidation":false,"script":"changed by redaction","partial":{"reason":"budget_exhausted","nextStep":"retry","checkpoint":{"scriptHash":"` + scriptHash("original tested script") + `","selfTestPassed":true}}}`,
		`{"message":"m","requestValidation":false,"script":"unverified","partial":{"reason":"budget_exhausted","nextStep":"retry"}}`,
	} {
		f := setupM10Partial(t)
		artifact, err := f.files.Save(f.assignment.ID, f.assignment.AttemptID, "author.json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err = f.p.SaveArtifact(f.ctx, artifact); err != nil {
			t.Fatal(err)
		}
		if err = f.p.Complete(f.ctx, "m10-partial", f.assignment.ID, f.assignment.AttemptID, Result{Status: "succeeded"}); err != nil {
			t.Fatal(err)
		}
		run, err := f.p.Run(f.ctx, f.assignment.ID)
		if err != nil || run.Status != "failed" || run.AuthorPartial != nil {
			t.Fatal("bad checkpoint became partial success", err)
		}
		draft, err := f.p.Draft(f.ctx, f.testID)
		if err != nil || draft.Script != "old script" || draft.Revision != f.revision {
			t.Fatal("bad checkpoint mutated draft", err)
		}
		if err = f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
			t.Fatal(err)
		}
		if _, err = f.p.ContinueAuthor(f.ctx, run.ID, f.sessionID, f.revision); !errors.Is(err, ErrConflict) {
			t.Fatal("continued invalid partial", err)
		}
	}
}

func TestM10PostgresLargeEscapedPartialReadAndApply(t *testing.T) {
	m10SkillRoot(t)
	f := setupM10Partial(t)
	script := "/*" + strings.Repeat("<", MaxScriptBytes-4) + "*/"
	f.finish(t, &script, "succeeded")
	run, err := f.p.Run(f.ctx, f.assignment.ID)
	if err != nil || run.Status != "succeeded" || run.AuthorPartial == nil {
		t.Fatal("escaped artifact read failed", err)
	}
	draft, err := f.p.Draft(f.ctx, f.testID)
	if err != nil || draft.Script != script {
		t.Fatal("escaped candidate was not applied", err)
	}
}
