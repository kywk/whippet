//go:build integration

package server

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestM10PostgresPlatformCandidateScopeAndReplay(t *testing.T) {
	for _, mode := range []string{"cancel", "complete", "stale_ref"} {
		t.Run(mode, func(t *testing.T) { m10PlatformCandidateFlow(t, mode) })
	}
}
func m10PlatformCandidateFlow(t *testing.T, mode string) {
	p, ctx, item, session, stage := m10PlanFixture(t)
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	manifest, pin, err := loadSkill(repositoryFile("runtimes", "worker", "skills"), "usecase-planner", registry)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	d, s, err := requireEditingDraft(ctx, tx, item.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	input := editingAuthorInput(s, d, "usecase-planner", []ChatMessage{{Role: "user", Content: "synthetic plan"}})
	input.SkillVersion = pin.Version
	input.Skills = []SkillSnapshot{pin}
	input.Platform = &AuthorPlatform{}
	input.Budget = &manifest.Budget
	input.Model = &manifest.Model
	input.ToolRegistryVersion = registry.Version
	input.ToolRegistrySHA256 = registry.SHA256
	input.AllowedTools = []string{"propose_plan", "read_plan", "catalog_get", "catalog_search"}
	run, err := enqueueAuthorSnapshot(ctx, tx, d, input)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO managers(singleton,id,capacity) VALUES(true,'m10-platform',1)`); err != nil {
		t.Fatal(err)
	}
	attempt := NewID()
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='running',manager_id='m10-platform',attempt_id=$2,slot_released=false WHERE id=$1`, run.ID, attempt); err != nil {
		t.Fatal(err)
	}
	args, _ := json.Marshal(map[string]any{"stages": []PlanStageInput{stage}})
	req := HarnessToolRequest{CallID: NewID(), Name: "propose_plan", Arguments: args}
	call := func(request HarnessToolRequest, allowed bool) (any, error) {
		return p.HarnessPlatform(ctx, "m10-platform", run.ID, attempt, request, registry, func() bool { return allowed })
	}
	result, err := call(req, true)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := call(req, true)
	var before, after any
	json.Unmarshal(result.(json.RawMessage), &before)
	if err == nil {
		json.Unmarshal(retry.(json.RawMessage), &after)
	}
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("retry changed candidate", err)
	}
	if _, err = call(req, false); err == nil {
		t.Fatal("epoch loss replay accepted")
	}
	changed := req
	changed.Arguments = json.RawMessage(`{"stages":[]}`)
	if _, err = call(changed, true); err == nil {
		t.Fatal("invalid proposal accepted")
	}
	var count int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM plan_candidates WHERE run_id=$1`, run.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("candidate count", count, err)
	}
	var proposed struct {
		CandidateRef string           `json:"candidateRef"`
		Stages       []PlanStageInput `json:"stages"`
	}
	json.Unmarshal(result.(json.RawMessage), &proposed)
	if !ValidID(proposed.CandidateRef) || proposed.Stages[0].ModuleTestID == "" {
		t.Fatal("candidate not canonical")
	}
	if mode != "cancel" {
		files, e := NewLocalArtifacts(t.TempDir())
		if e != nil {
			t.Fatal(e)
		}
		p.Artifacts = files
		if mode == "stale_ref" {
			req.CallID = NewID()
			if _, e = call(req, true); e != nil {
				t.Fatal(e)
			}
		}
		body := jsonText(map[string]any{"message": "canonical plan", "planCandidate": map[string]any{"candidateRef": proposed.CandidateRef}})
		artifact, e := files.Save(run.ID, attempt, "author.json", strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		if e = p.SaveArtifact(ctx, artifact); e != nil {
			t.Fatal(e)
		}
		if e = p.Complete(ctx, "m10-platform", run.ID, attempt, Result{Status: "succeeded"}); e != nil {
			t.Fatal(e)
		}
		completed, e := p.Run(ctx, run.ID)
		if e != nil {
			t.Fatal(e)
		}
		plan, e := p.Plan(ctx, item.ID, session.ID)
		if e != nil {
			t.Fatal(e)
		}
		if mode == "complete" {
			if completed.Status != "succeeded" || plan == nil || plan.Status != "draft" || plan.Stages[0].ModuleTestID != proposed.Stages[0].ModuleTestID {
				t.Fatal("canonical plan not applied", completed.Status)
			}
		} else if completed.Status != "failed" || plan != nil {
			t.Fatal("old candidate became final")
		}
		return
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelling' WHERE id=$1`, run.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = call(req, true); err == nil {
		t.Fatal("cancelled retry authorized")
	}
	if plan, err := p.Plan(ctx, item.ID, session.ID); err != nil || plan != nil {
		t.Fatal("proposal applied before author completion", err)
	}
}

func TestM10PostgresPlatformNormalEnqueue(t *testing.T) {
	p, ctx, item, session, _ := m10PlanFixture(t)
	sub, err := p.CreateAuthor(ctx, item.ID, session.ID, "Plan the synthetic flow", session.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err = p.DB.QueryRowContext(ctx, `SELECT author_payload FROM runs WHERE id=$1`, sub.Run.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var input AuthorInput
	if json.Unmarshal(raw, &input) != nil || input.SkillID != "usecase-planner" || input.Platform == nil || input.Platform.Module != nil {
		t.Fatal("planner routing")
	}
	registry, err := loadToolRegistry()
	if err != nil || validateToolSnapshot(input, registry, "propose_plan") != nil {
		t.Fatal("normal enqueue missing raw registry snapshot", err)
	}
	if _, err = p.CreateAuthor(ctx, item.ID, session.ID, "duplicate", session.Draft.Revision); err == nil {
		t.Fatal("active duplicate queued")
	}
	slug := "author-module"
	module, err := p.CreatePlatformTest(ctx, item.WorkspaceID, "module", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	editing, _, err := p.StartEditingSession(ctx, module.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.CreateAuthor(ctx, module.ID, editing.ID, "build module", editing.Draft.Revision); err == nil {
		t.Fatal("Module self-test without confirmed scope allowed")
	}
}
