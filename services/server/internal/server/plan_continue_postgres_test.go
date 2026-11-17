//go:build integration && m12module && m12edit

package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func stageCheckpointFixture(t *testing.T, engine string, reads int, real bool) (moduleCheckpointFixture, Test, EditingSession, *Plan, StageContinueRequest) {
	t.Helper()
	p, ctx, item, s, plan, request := splitFixture(t, true)
	if engine != "builtin" {
		var revision int
		if err := p.DB.QueryRowContext(ctx, `SELECT (settings->>'revision')::integer FROM workspaces WHERE id=$1`, item.WorkspaceID).Scan(&revision); err != nil {
			t.Fatal(err)
		}
		if _, err := p.SetAgentRuntime(ctx, item.WorkspaceID, revision, RuntimeSelection{ProfileID: engine, SkillProfiles: map[string]string{}}); err != nil {
			t.Fatal(err)
		}
	}
	var err error
	plan, err = p.SplitPlanStage(ctx, plan.ID, "work", request)
	if err != nil {
		t.Fatal("split", err)
	}
	plan, err = p.ConfirmPlanThrough(ctx, plan.ID, plan.Revision, "work-a")
	if err != nil {
		t.Fatal("confirm", err)
	}
	if err = p.RegisterManager(ctx, "split-manager", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "split-manager", 1)
	if err != nil || a == nil || a.ID != stringValue(plan.Stages[1].AuthorRunID) {
		t.Fatal("Stage claim", err)
	}
	files, ok := p.Artifacts.(*LocalArtifacts)
	if !ok {
		t.Fatal("prefix artifact store")
	}
	ms, err := readEditing(ctx, p.DB, stringValue(a.TestID), a.Author.EditingSessionID)
	if err != nil {
		t.Fatal(err)
	}
	f := moduleCheckpointFixture{p: p, ctx: ctx, item: Test{ID: stringValue(a.TestID), WorkspaceID: item.WorkspaceID}, session: ms, a: a, files: files}
	mode := "synthetic"
	if real {
		mode = "real"
	}
	raw := moduleEditWorker(t, f, true, mode, reads)
	f.manager(t, raw)
	r := f.finish(t, raw, "succeeded")
	if r.AuthorPartial == nil || r.AuthorPartial.Usage.ModelRequests != reads+1 {
		t.Fatal("Stage partial receipt")
	}
	// Before physical reclamation the Plan remains running and no candidate or
	// formal validation exists. The partial must not be mistaken for completion.
	before, err := p.Plan(ctx, item.ID, s.ID)
	if err != nil || before.Status != "running" {
		t.Fatal("paused before reclamation", err)
	}
	var count int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM module_validation_requests WHERE source_run_id=$1`, a.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("partial scheduled validation", err)
	}
	if err = p.ReleaseSlots(ctx, "split-manager", nil); err != nil {
		t.Fatal(err)
	}
	plan, err = p.Plan(ctx, item.ID, s.ID)
	if err != nil || plan.Status != "stopped" || stringValue(plan.Error) != stageCheckpointPause || plan.Stages[1].Status != "authoring" {
		t.Fatal("Stage not paused", err, plan)
	}
	return f, item, s, plan, StageContinueRequest{plan.Revision, a.ID, *r.AuthorPartial.AppliedRevision, true}
}

func TestPlanCheckpointPostgresSplitOneSlotContinuation(t *testing.T) {
	for _, engine := range []string{"builtin", "vercel"} {
		t.Run(engine, func(t *testing.T) {
			f, item, s, plan, request := stageCheckpointFixture(t, engine, 2, engine == "builtin")
			prefix := jsonText(plan.Stages[0])
			suffix := jsonText(plan.Stages[2:])
			var before string
			if err := f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, f.a.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			// A Workspace preference change affects new work, never this bound chain.
			if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE workspaces SET author_engine='external',agent_runtime='{"profileId":"builtin","skillProfiles":{}}'::jsonb WHERE id=$1`, item.WorkspaceID); err != nil {
				t.Fatal(err)
			}
			var children [2]*Plan
			var failures [2]error
			var wg sync.WaitGroup
			for i := range children {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					children[i], failures[i] = f.p.ContinuePlanStage(f.ctx, plan.ID, "work-a", request)
				}(i)
			}
			wg.Wait()
			if failures[0] != nil || failures[1] != nil || jsonText(children[0]) != jsonText(children[1]) {
				t.Fatal("duplicate Stage continuation", failures)
			}
			child := children[0]
			if jsonText(child.Stages[0]) != prefix || jsonText(child.Stages[2:]) != suffix || child.ThroughStageID == nil || *child.ThroughStageID != "work-a" {
				t.Fatal("prefix/parent/boundary changed")
			}
			a, err := f.p.Claim(f.ctx, "split-manager", 1)
			if err != nil || a == nil || a.ID != stringValue(child.Stages[1].AuthorRunID) || a.Author.Budget.MaxModelRequests != 1 || a.Author.Budget.MaxToolCalls != 3 || effectiveOutputTokens(a.Author.Budget) != 16384 || *a.Author.Runtime != *f.a.Author.Runtime {
				t.Fatal("child allocation or routing drift", err)
			}
			if !strings.Contains(jsonText(a.Author.Messages), "Original Stage decomposition") || !strings.Contains(jsonText(a.Author.Messages), "Approved Stage context") {
				t.Fatal("lost parent contract")
			}
			root := f.a.ID
			f.a = a
			mode := "synthetic"
			if engine == "builtin" {
				mode = "real"
			}
			raw := moduleEditWorker(t, f, false, mode, 0)
			f.manager(t, raw)
			done := f.finish(t, raw, "succeeded")
			if done.AuthorPartial != nil || done.Status != "succeeded" {
				t.Fatal("Stage completion failed")
			}
			if err = f.p.ReleaseSlots(f.ctx, "split-manager", nil); err != nil {
				t.Fatal(err)
			}
			plan, err = f.p.Plan(f.ctx, item.ID, s.ID)
			if err != nil || plan.Stages[1].Status != "validating" || plan.Stages[2].AuthorRunID != nil {
				t.Fatal("validation boundary", err)
			}
			var reservations, continuations int
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM plan_stage_split_runs WHERE plan_id=$1 AND stage_id='work-a' AND run_id=$2`, plan.ID, root).Scan(&reservations); err != nil || reservations != 1 {
				t.Fatal("root reservation changed", err)
			}
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM plan_stage_continuations WHERE source_run_id=$1`, root).Scan(&continuations); err != nil || continuations != 1 {
				t.Fatal("duplicate allocations", err)
			}
			var after string
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, root).Scan(&after); err != nil || after != before {
				t.Fatal("source mutated", err)
			}
		})
	}
}

func TestPlanCheckpointPostgresRejectsDriftAndExhaustion(t *testing.T) {
	for _, name := range []string{"request-cas", "module-revision", "module-context", "usecase-context", "authorization", "binding", "prefix", "cancel", "budget", "unconfirmed", "source", "pins", "wrong-stage"} {
		t.Run(name, func(t *testing.T) {
			reads := 0
			if name == "budget" {
				reads = 3
			}
			f, item, s, plan, request := stageCheckpointFixture(t, "builtin", reads, false)
			var err error
			switch name {
			case "request-cas":
				request.PlanRevision++
			case "module-revision":
				request.ModuleRevision++
			case "module-context":
				_, err = f.p.DB.ExecContext(f.ctx, `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=$1`, f.a.Author.EditingSessionID)
			case "usecase-context":
				_, err = f.p.DB.ExecContext(f.ctx, `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=$1`, s.ID)
			case "authorization":
				_, err = f.p.DB.ExecContext(f.ctx, `UPDATE workspaces SET authorization_revision=authorization_revision+1 WHERE id=$1`, item.WorkspaceID)
			case "binding":
				plan.Stages[1].Bind = "changed"
				_, err = f.p.DB.ExecContext(f.ctx, `UPDATE plans SET stages=$2 WHERE id=$1`, plan.ID, jsonText(plan.Stages))
			case "prefix":
				plan.Stages[0].CandidateVersionID = stringPointer(NewID())
				_, err = f.p.DB.ExecContext(f.ctx, `UPDATE plans SET stages=$2 WHERE id=$1`, plan.ID, jsonText(plan.Stages))
			case "cancel":
				_, err = f.p.CancelPlan(f.ctx, plan.ID, plan.Revision)
			case "unconfirmed":
				request.Confirmed = false
			case "source":
				request.SourceRunID = NewID()
			case "pins":
				raw, e := os.ReadFile(repositoryFile("contracts", "tools", "registry.json"))
				if e != nil {
					t.Fatal(e)
				}
				path := filepath.Join(t.TempDir(), "registry.json")
				if e = os.WriteFile(path, append(raw, '\n'), 0600); e != nil {
					t.Fatal(e)
				}
				t.Setenv("WHIPPET_TOOL_REGISTRY_PATH", path)
			}
			if err != nil {
				t.Fatal(err)
			}
			stageID := "work-a"
			if name == "wrong-stage" {
				stageID = "work"
			}
			_, err = f.p.ContinuePlanStage(f.ctx, plan.ID, stageID, request)
			if err == nil || name == "budget" && !errors.Is(err, ErrContinuationBudget) {
				t.Fatal("unsafe Stage continuation accepted", err)
			}
			var count int
			if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM author_continuations WHERE source_run_id=$1`, f.a.ID).Scan(&count); err != nil || count != 0 {
				t.Fatal("rejection partially allocated", err)
			}
		})
	}
}

func TestPlanCheckpointPostgresThreeRunCap(t *testing.T) {
	f, item, s, plan, request := stageCheckpointFixture(t, "builtin", 0, false)
	for ordinal := 2; ordinal <= 3; ordinal++ {
		var err error
		plan, err = f.p.ContinuePlanStage(f.ctx, plan.ID, "work-a", request)
		if err != nil {
			t.Fatal(err)
		}
		a, err := f.p.Claim(f.ctx, "split-manager", 1)
		if err != nil || a == nil || a.ID != stringValue(plan.Stages[1].AuthorRunID) {
			t.Fatal("child", err)
		}
		if a.Author.Budget.MaxModelRequests != 5-ordinal || a.Author.Budget.MaxToolCalls != 7-ordinal {
			t.Fatal("replenished allocation")
		}
		f.a = a
		raw := moduleEditWorker(t, f, true, "synthetic", 0)
		f.manager(t, raw)
		r := f.finish(t, raw, "succeeded")
		if r.AuthorPartial == nil || r.AuthorPartial.Usage.ModelRequests != 1 {
			t.Fatal("missing receipt")
		}
		if err = f.p.ReleaseSlots(f.ctx, "split-manager", nil); err != nil {
			t.Fatal(err)
		}
		plan, err = f.p.Plan(f.ctx, item.ID, s.ID)
		if err != nil || plan.Status != "stopped" {
			t.Fatal("pause", err)
		}
		request = StageContinueRequest{plan.Revision, a.ID, *r.AuthorPartial.AppliedRevision, true}
	}
	if _, err := f.p.ContinuePlanStage(f.ctx, plan.ID, "work-a", request); !errors.Is(err, ErrContinuationBudget) {
		t.Fatal("fourth Run minted credit", err)
	}
	var count int
	if err := f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM plan_stage_continuations WHERE plan_id=$1`, plan.ID).Scan(&count); err != nil || count != 2 {
		t.Fatal("chain cap", err)
	}
}

func TestPlanCheckpointPostgresHTTP(t *testing.T) {
	f, _, _, plan, body := stageCheckpointFixture(t, "builtin", 0, false)
	admin := NewID()
	api := NewAPI(f.p, nil, NewEngine(f.p, slog.New(slog.NewTextHandler(io.Discard, nil))), NewID(), slog.Default()).WithAdminAccess(admin, "").Handler(nil)
	path := "/api/plans/" + plan.ID + "/stages/work-a/continue"
	send := func(raw string) int {
		r := httptest.NewRequest("POST", path, strings.NewReader(raw))
		r.Header.Set("X-Whippet-Admin-Token", admin)
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		return w.Code
	}
	raw := jsonText(body)
	for _, invalid := range []string{`{}`, strings.Replace(raw, `"confirmed":true`, `"confirmed":null`, 1), strings.Replace(raw, `"confirmed":true`, `"confirmed":true,"confirmed":true`, 1), strings.TrimSuffix(raw, "}") + `,"budget":{"maxModelRequests":9}}`} {
		if status := send(invalid); status != 400 {
			t.Fatal("invalid body", status)
		}
	}
	if status := send(raw); status != 200 {
		t.Fatal("continue", status)
	}
	if status := send(raw); status != 200 {
		t.Fatal("idempotent response", status)
	}
	body.ModuleRevision++
	if status := send(jsonText(body)); status != 409 {
		t.Fatal("mismatched replay", status)
	}
}

func TestPlanCheckpointPostgresFailedRealRepair(t *testing.T) {
	f, _, _, plan, request := stageCheckpointFixture(t, "builtin", 0, false)
	before, err := f.p.EditingSession(f.ctx, stringValue(f.a.TestID), f.a.Author.EditingSessionID)
	if err != nil {
		t.Fatal(err)
	}
	plan, err = f.p.ContinuePlanStage(f.ctx, plan.ID, "work-a", request)
	if err != nil {
		t.Fatal(err)
	}
	a, err := f.p.Claim(f.ctx, "split-manager", 1)
	if err != nil || a == nil {
		t.Fatal("repair child", err)
	}
	f.a = a
	raw := moduleEditWorker(t, f, true, "fail", 0)
	var receipt struct {
		ExpectedFailure   bool `json:"expectedFailure"`
		CheckpointCreated bool `json:"checkpointCreated"`
	}
	if json.Unmarshal(raw, &receipt) != nil || !receipt.ExpectedFailure || receipt.CheckpointCreated {
		t.Fatal("failed real repair created checkpoint")
	}
	if err = f.p.Complete(f.ctx, "split-manager", a.ID, a.AttemptID, Result{Status: "failed"}); err != nil {
		t.Fatal(err)
	}
	if err = f.p.ReleaseSlots(f.ctx, "split-manager", nil); err != nil {
		t.Fatal(err)
	}
	after, err := f.p.EditingSession(f.ctx, stringValue(a.TestID), a.Author.EditingSessionID)
	if err != nil || after.Draft.Revision != before.Draft.Revision || after.Draft.Script != before.Draft.Script || moduleCheckpointHash(after.Draft.Module) != moduleCheckpointHash(before.Draft.Module) {
		t.Fatal("failed Stage repair replaced checkpoint", err)
	}
	var validations int
	if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM module_validation_requests WHERE test_id=$1`, a.TestID).Scan(&validations); err != nil || validations != 0 {
		t.Fatal("failed Stage validation", err)
	}
}
