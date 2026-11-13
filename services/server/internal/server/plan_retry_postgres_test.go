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

func retryFixture(t *testing.T, validation bool) (*Postgres, context.Context, *Plan, StageRetryRequest) {
	t.Helper()
	p, ctx, item, editing, reuse := m10PlanFixture(t)
	config := WorkspaceConfig{Name: "retry", Purpose: "synthetic", BackgroundSummary: "synthetic", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://example.test", Purpose: "test"}}}
	if _, err := p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, item.WorkspaceID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DiscardEditingSession(ctx, item.ID, editing.ID, editing.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	editing, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	create := PlanStageInput{ID: "repair", Title: "repair", Action: "create", Module: &PlannedModule{Slug: "repair", ModuleKind: "step", Description: "synthetic"}, Args: map[string]StageArgument{}}
	later := create
	later.ID = "later"
	later.Module = &PlannedModule{Slug: "later", ModuleKind: "step", Description: "later"}
	plan, err := p.SavePlan(ctx, item.ID, editing.ID, editing.Draft.Revision, 0, []PlanStageInput{reuse, create, later})
	if err != nil {
		t.Fatal(err)
	}
	plan, err = p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "retry-manager", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "retry-manager", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	if validation {
		files, err := NewLocalArtifacts(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		p.Artifacts = files
		meta := *a.Author.Platform.Module
		meta.ExportName = "prepare"
		meta.Harness = strings.ReplaceAll(m10BundleSpec, "@lib/setup", "@lib/repair")
		artifact, err := files.Save(a.ID, a.AttemptID, "author.json", strings.NewReader(jsonText(map[string]any{"message": "candidate", "script": m10BundleModule, "module": meta, "requestValidation": true})))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatal(err)
		}
		if err = p.Complete(ctx, "retry-manager", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
			t.Fatal(err)
		}
		if err = p.ReleaseSlots(ctx, "retry-manager", nil); err != nil {
			t.Fatal(err)
		}
		a, err = p.Claim(ctx, "retry-manager", 1)
		if err != nil || a == nil || a.Kind != "validation" {
			t.Fatal("validation", err)
		}
	}
	if err = p.Complete(ctx, "retry-manager", a.ID, a.AttemptID, Result{Status: "failed", Error: "synthetic"}); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "retry-manager", nil); err != nil {
		t.Fatal(err)
	}
	plan, err = p.Plan(ctx, item.ID, editing.ID)
	if err != nil || plan.Status != "stopped" {
		t.Fatal("not stopped", err)
	}
	r, err := p.StageRetry(ctx, plan.ID, "repair")
	if err != nil || !r.Eligible {
		t.Fatalf("eligibility %+v %v", r, err)
	}
	return p, ctx, plan, StageRetryRequest{plan.Revision, r.Source.ModuleRevision, r.Source.ModuleContextRevision, true, "修復合成案例"}
}

func TestM109StageRetryAtomicAndIdempotent(t *testing.T) {
	for _, validation := range []bool{false, true} {
		t.Run(map[bool]string{false: "author_failed", true: "validation_failed"}[validation], func(t *testing.T) {
			p, ctx, plan, body := retryFixture(t, validation)
			// PostgreSQL itself enforces the pure-read contract, not an HTTP mock.
			p.DB.SetMaxOpenConns(1)
			if _, err := p.DB.ExecContext(ctx, `SET default_transaction_read_only=on`); err != nil {
				t.Fatal(err)
			}
			got, err := p.StageRetry(ctx, plan.ID, "repair")
			if err != nil || !got.Eligible {
				t.Fatal("read only", got, err)
			}
			if _, err = p.DB.ExecContext(ctx, `SET default_transaction_read_only=off`); err != nil {
				t.Fatal(err)
			}
			p.DB.SetMaxOpenConns(8)
			var wg sync.WaitGroup
			results := make([]*Plan, 2)
			errs := make([]error, 2)
			for i := range results {
				wg.Add(1)
				go func(i int) { defer wg.Done(); results[i], errs[i] = p.RetryPlanStage(ctx, plan.ID, "repair", body) }(i)
			}
			wg.Wait()
			if errs[0] != nil || errs[1] != nil {
				t.Fatal(errs)
			}
			a, b := results[0], results[1]
			if *a.Stages[1].AuthorRunID != *b.Stages[1].AuthorRunID || a.Revision != plan.Revision+1 || a.Status != "running" || a.Stages[0].ModuleVersionID != plan.Stages[0].ModuleVersionID || a.Stages[2].Status != "pending" || a.Stages[1].CandidateVersionID != nil || a.Stages[1].ValidationRunID != nil {
				t.Fatal("retry mutated wrong stage")
			}
			var count int
			if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM plan_stage_retries WHERE plan_id=$1`, plan.ID).Scan(&count); err != nil || count != 1 {
				t.Fatal(count, err)
			}
			changed := body
			changed.Content += "different"
			if _, err = p.RetryPlanStage(ctx, plan.ID, "repair", changed); !errors.Is(err, ErrConflict) {
				t.Fatal("different body", err)
			}
			if _, err = p.CancelPlan(ctx, plan.ID, a.Revision); err != nil {
				t.Fatal(err)
			}
			replay, err := p.RetryPlanStage(ctx, plan.ID, "repair", body)
			if err != nil || *replay.Stages[1].AuthorRunID != *a.Stages[1].AuthorRunID {
				t.Fatal("cancel replay", err)
			}
			now, err := p.Plan(ctx, plan.TestID, plan.EditingSessionID)
			if err != nil || now.Status != "stopped" {
				t.Fatal("resurrected", err)
			}
			r, err := p.StageRetry(ctx, plan.ID, "repair")
			if err != nil || r.Eligible || stringValue(r.Reason) != "cancelled" {
				t.Fatal(r, err)
			}
		})
	}
}

func TestM109StageRetryGuardsAndRollback(t *testing.T) {
	for _, mode := range []string{"reclaim", "context", "usecase_context", "cancelled", "scope", "prior", "rollback"} {
		t.Run(mode, func(t *testing.T) {
			p, ctx, plan, body := retryFixture(t, false)
			source := *plan.Stages[1].AuthorRunID
			var sqlText string
			var arg any = source
			switch mode {
			case "reclaim":
				sqlText = `UPDATE runs SET slot_released=false WHERE id=$1`
			case "context":
				sqlText = `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=(SELECT editing_session_id FROM runs WHERE id=$1)`
			case "usecase_context":
				sqlText = `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=$1`
				arg = plan.EditingSessionID
			case "cancelled":
				sqlText = `UPDATE runs SET status='cancelled' WHERE id=$1`
			case "scope":
				sqlText = `UPDATE workspaces SET lifecycle='draft',canonical_config=NULL WHERE id=(SELECT workspace_id FROM runs WHERE id=$1)`
			case "prior":
				plan.Stages[0].ModuleVersionID = NewID()
				sqlText = `UPDATE plans SET stages=$2 WHERE id=$1`
				arg = plan.ID
			case "rollback":
				sqlText = `CREATE FUNCTION reject_retry_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$`
				arg = nil
			}
			var err error
			if mode == "prior" {
				_, err = p.DB.ExecContext(ctx, sqlText, arg, jsonText(plan.Stages))
			} else if mode == "rollback" {
				_, err = p.DB.ExecContext(ctx, sqlText)
				if err == nil {
					_, err = p.DB.ExecContext(ctx, `CREATE TRIGGER reject_retry_fixture BEFORE INSERT ON plan_stage_retries FOR EACH ROW EXECUTE FUNCTION reject_retry_fixture()`)
				}
			} else {
				_, err = p.DB.ExecContext(ctx, sqlText, arg)
			}
			if err != nil {
				t.Fatal(err)
			}
			var before int
			if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			if mode != "rollback" {
				r, err := p.StageRetry(ctx, plan.ID, "repair")
				if err != nil || r.Eligible {
					t.Fatal(r, err)
				}
			}
			if _, err = p.RetryPlanStage(ctx, plan.ID, "repair", body); err == nil {
				t.Fatal("guard accepted")
			}
			var after, count int
			p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs`).Scan(&after)
			p.DB.QueryRowContext(ctx, `SELECT count(*) FROM plan_stage_retries`).Scan(&count)
			if before != after || count != 0 {
				t.Fatal("partial transaction")
			}
		})
	}
}

func TestM109StageRetryHTTP(t *testing.T) {
	p, ctx, plan, body := retryFixture(t, false)
	api := NewAPI(p, nil, NewEngine(p, slog.New(slog.NewTextHandler(io.Discard, nil))), "synthetic-manager", slog.Default()).Handler(nil)
	path := "/api/plans/" + plan.ID + "/stages/repair/retry"
	for _, payload := range []string{`{}`, `{"planRevision":1,"moduleRevision":1,"moduleContextRevision":null,"confirmed":true,"content":"repair"}`, strings.TrimSuffix(jsonText(body), "}") + `,"moduleTestId":"` + NewID() + `"}`} {
		w := httptest.NewRecorder()
		api.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader(payload)))
		if w.Code != 400 {
			t.Fatal("bad body", w.Code)
		}
	}
	w := httptest.NewRecorder()
	api.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	var envelope struct {
		Retry StageRetry `json:"retry"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || !envelope.Retry.Eligible {
		t.Fatal("GET", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	api.ServeHTTP(w, httptest.NewRequest("GET", "/api/plans/"+plan.ID+"/stages/missing/retry", nil))
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	api.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader(jsonText(body))))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := p.StageRetry(ctx, plan.ID, "repair"); err != nil {
		t.Fatal(err)
	}
}

func TestM109StageRetryPriorCandidateAndLateValidation(t *testing.T) {
	p, ctx, plan, _ := retryFixture(t, true)
	prior := plan.Stages[1]
	var attempt string
	if err := p.DB.QueryRowContext(ctx, `SELECT attempt_id FROM runs WHERE id=$1`, *prior.ValidationRunID).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	// Turn this isolated failed-validation fixture into a proven ready predecessor.
	// No live worker/model or application data is involved.
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='collecting' WHERE id=$1`, *prior.ValidationRunID); err != nil {
		t.Fatal(err)
	}
	files := p.Artifacts.(*LocalArtifacts)
	for name, body := range map[string]string{"report.html": "<html>synthetic</html>", "results.json": `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`} {
		a, err := files.Save(*prior.ValidationRunID, attempt, name, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='succeeded' WHERE id=$1`, *prior.ValidationRunID); err != nil {
		t.Fatal(err)
	}
	plan.Stages[1].Status = "ready"
	if _, err := p.DB.ExecContext(ctx, `UPDATE plans SET status='running',stages=$2 WHERE id=$1`, plan.ID, jsonText(plan.Stages)); err != nil {
		t.Fatal(err)
	}
	if err := p.progressRunningPlans(ctx); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "retry-manager", 1)
	if err != nil || a == nil {
		t.Fatal(err)
	}
	if err = p.Complete(ctx, "retry-manager", a.ID, a.AttemptID, Result{Status: "failed"}); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "retry-manager", nil); err != nil {
		t.Fatal(err)
	}
	plan, err = p.Plan(ctx, plan.TestID, plan.EditingSessionID)
	if err != nil {
		t.Fatal(err)
	}
	// Includes the read-only proof path for a ready candidate (no FOR UPDATE).
	eligibility, err := p.StageRetry(ctx, plan.ID, "later")
	if err != nil || !eligibility.Eligible {
		t.Fatal(eligibility, err)
	}
	body := StageRetryRequest{plan.Revision, eligibility.Source.ModuleRevision, eligibility.Source.ModuleContextRevision, true, "repair later"}
	retried, err := p.RetryPlanStage(ctx, plan.ID, "later", body)
	if err != nil {
		t.Fatal(err)
	}
	if jsonText(retried.Stages[1]) != jsonText(plan.Stages[1]) {
		t.Fatal("ready candidate changed")
	}
	// Replay an old unresolved validation request after the Plan is running again.
	// Even with exact draft/context, its stage/source is no longer authoring.
	if _, err = p.DB.ExecContext(ctx, `UPDATE module_validation_requests SET resolved=false,validation_run_id=NULL WHERE source_run_id=$1`, *prior.AuthorRunID); err != nil {
		t.Fatal(err)
	}
	var before, after int
	p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs`).Scan(&before)
	var sid string
	p.DB.QueryRowContext(ctx, `SELECT editing_session_id FROM runs WHERE id=$1`, *prior.AuthorRunID).Scan(&sid)
	if err = p.scheduleModuleValidation(ctx, *prior.AuthorRunID, prior.ModuleTestID, sid); err != nil {
		t.Fatal(err)
	}
	p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs`).Scan(&after)
	if before != after {
		t.Fatal("old validation resurrected")
	}
}

func TestM109StageRetryOldSourceCannotSchedule(t *testing.T) {
	p, ctx, plan, body := retryFixture(t, true)
	old := plan.Stages[1]
	retried, err := p.RetryPlanStage(ctx, plan.ID, "repair", body)
	if err != nil {
		t.Fatal(err)
	}
	var sid string
	if err = p.DB.QueryRowContext(ctx, `SELECT editing_session_id FROM runs WHERE id=$1`, *old.AuthorRunID).Scan(&sid); err != nil {
		t.Fatal(err)
	}
	// Force all other scheduler predicates true to isolate the new source guard.
	if _, err = p.DB.ExecContext(ctx, `UPDATE module_validation_requests SET resolved=false,validation_run_id=NULL,context_revision=(SELECT context_revision FROM editing_sessions WHERE id=$2) WHERE source_run_id=$1`, *old.AuthorRunID, sid); err != nil {
		t.Fatal(err)
	}
	var before, after int
	p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs`).Scan(&before)
	if err = p.scheduleModuleValidation(ctx, *old.AuthorRunID, old.ModuleTestID, sid); err != nil {
		t.Fatal(err)
	}
	p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs`).Scan(&after)
	if before != after {
		t.Fatal("old source scheduled")
	}
	var raw []byte
	if err = p.DB.QueryRowContext(ctx, `SELECT author_payload FROM runs WHERE id=$1`, *retried.Stages[1].AuthorRunID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var input AuthorInput
	if json.Unmarshal(raw, &input) != nil || input.ContextRevision != body.ModuleContextRevision+1 || input.EditingSessionID != sid {
		t.Fatal("fresh snapshot/session wrong")
	}
}

func TestM109StageRetryCancelHistory(t *testing.T) {
	for _, mode := range []string{"author_cancel_failed", "validation_cancel_failed", "legacy_unknown"} {
		t.Run(mode, func(t *testing.T) {
			p, ctx, plan, body := retryFixture(t, mode == "validation_cancel_failed")
			run := *plan.Stages[1].AuthorRunID
			if mode == "validation_cancel_failed" {
				run = *plan.Stages[1].ValidationRunID
			}
			var marker *bool
			if err := p.DB.QueryRowContext(ctx, `SELECT cancel_requested FROM runs WHERE id=$1`, run).Scan(&marker); err != nil || marker == nil || *marker {
				t.Fatal("new Run must be explicit false", err)
			}
			expected := "cancelled"
			if mode == "legacy_unknown" {
				// Simulate the post-migration unknown historical state, never a live override.
				if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET cancel_requested=NULL WHERE id=$1`, run); err != nil {
					t.Fatal(err)
				}
				expected = "source_unavailable"
			} else {
				if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelling' WHERE id=$1`, run); err != nil {
					t.Fatal(err)
				}
			}
			for _, reset := range []string{"false", "NULL"} {
				if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='failed',cancel_requested=`+reset+` WHERE id=$1`, run); err != nil {
					t.Fatal(err)
				}
				if err := p.DB.QueryRowContext(ctx, `SELECT cancel_requested FROM runs WHERE id=$1`, run).Scan(&marker); err != nil {
					t.Fatal(err)
				}
				if mode == "legacy_unknown" {
					if marker != nil {
						t.Fatal("unknown reset")
					}
				} else if marker == nil || !*marker {
					t.Fatal("true reset")
				}
			}
			r, err := p.StageRetry(ctx, plan.ID, "repair")
			if err != nil || r.Eligible || stringValue(r.Reason) != expected {
				t.Fatal(r, err)
			}
			if _, err = p.RetryPlanStage(ctx, plan.ID, "repair", body); !errors.Is(err, ErrConflict) {
				t.Fatal("cancel/unknown accepted", err)
			}
		})
	}
}

func TestM109StageRetryMigrationHistoricalMarkers(t *testing.T) {
	for _, status := range []string{"failed", "cancelling", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			p, ctx, plan, _ := retryFixture(t, false)
			source := *plan.Stages[1].AuthorRunID
			// Recreate the 018 schema shape in this disposable test schema, then apply
			// the actual embedded 019 to existing rows (not a hand-written backfill).
			for _, statement := range []string{`DROP TRIGGER preserve_run_cancel_history ON runs`, `DROP FUNCTION whippet_preserve_cancel_history()`, `ALTER TABLE runs DROP COLUMN cancel_requested`, `DROP TABLE plan_stage_retries`, `DELETE FROM schema_migrations WHERE name='019_plan_stage_retries.sql'`} {
				if _, err := p.DB.ExecContext(ctx, statement); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status=$2 WHERE id=$1`, source, status); err != nil {
				t.Fatal(err)
			}
			if err := p.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			var marker *bool
			if err := p.DB.QueryRowContext(ctx, `SELECT cancel_requested FROM runs WHERE id=$1`, source).Scan(&marker); err != nil {
				t.Fatal(err)
			}
			if status == "failed" {
				if marker != nil {
					t.Fatal("historical false invented")
				}
			} else if marker == nil || !*marker {
				t.Fatal("cancel history lost")
			}
			if err := p.Migrate(ctx); err != nil {
				t.Fatal("migration replay", err)
			}
		})
	}
}
