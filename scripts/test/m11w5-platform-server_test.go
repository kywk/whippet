//go:build integration

// This suite drives the real in-process MCP handler and an isolated PostgreSQL
// schema. Published Module seeds are synthetic SQL fixtures: they are not
// Docker, Playwright, model, or UI validation evidence.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type m11w5Client struct {
	t      *testing.T
	h      http.Handler
	secret string
}

func m11w5ClientFor(t *testing.T, p *Postgres, workspace string) m11w5Client {
	t.Helper()
	_, secret, err := p.CreateAgentToken(context.Background(), workspace, "synthetic QA")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return m11w5Client{t, NewAPI(p, nil, NewEngine(p, log), NewID(), log).WithAdminAccess(NewID(), "https://whippet.example").Handler(nil), secret}
}
func (c m11w5Client) request(method string, params any) (map[string]any, bool) {
	c.t.Helper()
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		c.t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+c.secret)
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	if rec.Code != 200 && rec.Code != 400 {
		c.t.Fatalf("unexpected HTTP %d; result inconclusive", rec.Code)
	}
	var wire struct {
		Result struct {
			Structured map[string]any `json:"structuredContent"`
			Tools      []struct {
				Name string `json:"name"`
			} `json:"tools"`
			IsError bool `json:"isError"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &wire) != nil {
		c.t.Fatal("invalid MCP response")
	}
	if method == "tools/list" {
		names := []string{}
		for _, tool := range wire.Result.Tools {
			names = append(names, tool.Name)
		}
		return map[string]any{"names": names}, rec.Code != 200 || len(wire.Error) > 0
	}
	return wire.Result.Structured, rec.Code != 200 || wire.Result.IsError || len(wire.Error) > 0
}
func (c m11w5Client) call(name string, args any) (map[string]any, bool) {
	return c.request("tools/call", map[string]any{"name": name, "arguments": args})
}
func (c m11w5Client) claim(run, skill string) map[string]any {
	c.t.Helper()
	result, bad := c.call("task_claim", map[string]any{"requestId": NewID()})
	task, ok := result["task"].(map[string]any)
	if bad || !ok || task["runId"] != run {
		c.t.Fatal("claim failed or returned wrong run")
	}
	bundle, ok := task["contextBundle"].(map[string]any)
	if !ok {
		c.t.Fatal("missing bundle")
	}
	author, ok := bundle["author"].(map[string]any)
	if !ok || author["skillId"] != skill || bundle["skillUri"] != "whippet://skill/"+skill+"/main" || bundle["externalReferenceUri"] != "whippet://skill/"+skill+"/references/external-mcp" {
		c.t.Fatal("wrong skill snapshot")
	}
	return task
}
func m11w5IDs(task map[string]any) map[string]any {
	return map[string]any{"runId": task["runId"], "attemptId": task["attemptId"], "leaseId": task["leaseId"]}
}
func m11w5Args(task map[string]any, id string, output any) map[string]any {
	a := m11w5IDs(task)
	a["submitId"] = id
	a["output"] = output
	return a
}
func m11w5Tool(task map[string]any, name string, args any) map[string]any {
	a := m11w5IDs(task)
	a["callId"] = NewID()
	a["name"] = name
	a["arguments"] = args
	return a
}
func m11w5Ready(t *testing.T, p *Postgres, ctx context.Context, workspace string) {
	t.Helper()
	w, err := p.Workspace(ctx, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.SetAuthorEngine(ctx, workspace, w.Revision, "external"); err != nil {
		t.Fatal(err)
	}
	// Synthetic scope setup is confined to the per-test schema.
	cfg := WorkspaceConfig{Name: "fixture", Targets: []WorkspaceOrigin{{Name: "fixture", Origin: "https://m11.invalid"}}, Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{}, TimeoutMS: 15000}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,canonical_config=$2 WHERE id=$1`, workspace, jsonText(cfg)); err != nil {
		t.Fatal(err)
	}
}
func m11w5Artifacts(t *testing.T, p *Postgres) {
	t.Helper()
	a, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = a
}
func m11w5RejectedOrFailed(t *testing.T, p *Postgres, ctx context.Context, runID string, rejected bool) {
	t.Helper()
	run, err := p.Run(ctx, runID)
	if err != nil || (!rejected && run.Status != "failed") || run.Status == "succeeded" {
		t.Fatal("invalid submission was neither rejected nor marked failed", err)
	}
}
func m11w5AssertNoHumanTools(t *testing.T, c m11w5Client) {
	t.Helper()
	out, bad := c.request("tools/list", map[string]any{})
	if bad {
		t.Fatal("tools/list failed")
	}
	names, ok := out["names"].([]string)
	if !ok {
		t.Fatal("missing tools")
	}
	for _, name := range names {
		n := strings.ToLower(name)
		if strings.Contains(n, "publish") || strings.Contains(n, "confirm") {
			t.Fatalf("human confirmation tool exposed: %s", name)
		}
	}
	if _, bad = c.call("confirm_plan", map[string]any{}); !bad {
		t.Fatal("MCP accepted confirm_plan")
	}
}

func TestM11W5PlatformModule(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "stale"}[stale], func(t *testing.T) {
			p, ctx := workspaceTestDB(t)
			if err := p.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			m11w5Artifacts(t, p)
			w, err := p.CreateWorkspace(ctx, "module fixture")
			if err != nil {
				t.Fatal(err)
			}
			m11w5Ready(t, p, ctx, w.ID)
			slug := "synthetic"
			item, err := p.CreatePlatformTest(ctx, w.ID, "Module", "", "module", &slug)
			if err != nil {
				t.Fatal(err)
			}
			session, _, err := p.StartEditingSession(ctx, item.ID)
			if err != nil {
				t.Fatal(err)
			}
			sub, err := p.CreateAuthor(ctx, item.ID, session.ID, "Prepare a module", session.Draft.Revision)
			if err != nil {
				t.Fatal(err)
			}
			if sub.Run.AuthorEngine != "external" {
				t.Fatal("Module not routed external")
			}
			c := m11w5ClientFor(t, p, w.ID)
			task := c.claim(sub.Run.ID, "module-authoring")
			meta := Module{Slug: slug, ModuleKind: "step", ExportName: "prepare", Harness: "import {test,expect} from '@playwright/test'; import {prepare} from '@lib/synthetic'; test('module',async()=>{expect(await prepare({})).toEqual({name:'alpha'});});"}
			output := map[string]any{"message": "candidate", "script": "export async function prepare(_args:any){return {name:'alpha'};}", "module": meta, "requestValidation": true}
			badOutput := map[string]any{}
			for k, v := range output {
				badOutput[k] = v
			}
			badOutput["selfTestPassed"] = true
			if _, bad := c.call("task_submit", m11w5Args(task, NewID(), badOutput)); !bad {
				t.Fatal("self-reported selftest accepted")
			}
			badOutput["proof"] = true
			delete(badOutput, "selfTestPassed")
			if _, bad := c.call("task_submit", m11w5Args(task, NewID(), badOutput)); !bad {
				t.Fatal("self-reported proof accepted")
			}
			raw, err := json.Marshal(output)
			if err != nil {
				t.Fatal(err)
			}
			duplicate := append(append([]byte{}, raw[:len(raw)-1]...), []byte(`,"message":"duplicate"}`)...)
			if _, bad := c.call("task_submit", m11w5Args(task, NewID(), json.RawMessage(duplicate))); !bad {
				t.Fatal("duplicate output key accepted")
			}
			if stale {
				if _, err = p.SaveDraft(ctx, item.ID, session.ID, session.Draft.Revision, "// human edit"); err != nil {
					t.Fatal(err)
				}
			}
			id := NewID()
			got, bad := c.call("task_submit", m11w5Args(task, id, output))
			d, err := p.Draft(ctx, item.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stale {
				if d.Script != "// human edit" || d.ScriptOrigin == "ai" || d.ValidationRunID != nil {
					t.Fatal("stale candidate overwrote human draft or queued validation")
				}
				m11w5RejectedOrFailed(t, p, ctx, sub.Run.ID, bad)
				return
			}
			if bad || got["state"] != "submitted" || d.ScriptOrigin != "ai" || d.Script != output["script"] || d.Module == nil {
				t.Fatal("candidate was not applied as AI draft")
			}
			// Validation may be queued asynchronously after reclaim, but a self-test is never asserted.
			var count int
			if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM module_validation_requests WHERE source_run_id=$1`, sub.Run.ID).Scan(&count); err != nil || count != 1 {
				t.Fatal("independent validation request missing", err)
			}
			replay, bad := c.call("task_submit", m11w5Args(task, id, output))
			if bad || !reflect.DeepEqual(got, replay) {
				t.Fatal("submit replay changed")
			}
			changed := map[string]any{}
			for k, v := range output {
				changed[k] = v
			}
			changed["message"] = "changed"
			if _, bad = c.call("task_submit", m11w5Args(task, id, changed)); !bad {
				t.Fatal("changed replay accepted")
			}
		})
	}
}

func TestM11W5PlatformPlanner(t *testing.T) {
	for _, mode := range []string{"current", "forged", "stale"} {
		t.Run(mode, func(t *testing.T) {
			p, ctx, item, session, stage := m10PlanFixture(t)
			m11w5Artifacts(t, p)
			m11w5Ready(t, p, ctx, item.WorkspaceID)
			sub, err := p.CreateAuthor(ctx, item.ID, session.ID, "Plan synthetic flow", session.Draft.Revision)
			if err != nil {
				t.Fatal(err)
			}
			if sub.Run.AuthorEngine != "external" {
				t.Fatal("planner not external")
			}
			c := m11w5ClientFor(t, p, item.WorkspaceID)
			task := c.claim(sub.Run.ID, "usecase-planner")
			wrong := m11w5Tool(task, "propose_plan", map[string]any{"stages": []PlanStageInput{stage}})
			wrong["leaseId"] = NewID()
			if _, bad := c.call("task_tool_call", wrong); !bad {
				t.Fatal("wrong lease issued candidate")
			}
			proposed, bad := c.call("task_tool_call", m11w5Tool(task, "propose_plan", map[string]any{"stages": []PlanStageInput{stage}}))
			ref, ok := proposed["candidateRef"].(string)
			if bad || !ok || !ValidID(ref) {
				t.Fatal("Server did not issue candidateRef")
			}
			if mode == "forged" {
				ref = NewID()
			}
			var human *Plan
			if mode == "stale" {
				human, err = p.SavePlan(ctx, item.ID, session.ID, session.Draft.Revision, 0, []PlanStageInput{stage})
				if err != nil {
					t.Fatal(err)
				}
			}
			output := map[string]any{"message": "draft plan", "planCandidate": map[string]any{"candidateRef": ref}}
			id := NewID()
			got, bad := c.call("task_submit", m11w5Args(task, id, output))
			plan, err := p.Plan(ctx, item.ID, session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if mode != "current" {
				if mode == "forged" && plan != nil {
					t.Fatal("forged candidate produced plan")
				}
				if mode == "stale" && (plan == nil || plan.ID != human.ID || plan.Revision != human.Revision || plan.Status != "draft") {
					t.Fatal("human plan lost or altered")
				}
				m11w5RejectedOrFailed(t, p, ctx, sub.Run.ID, bad)
				return
			}
			if bad || got["state"] != "submitted" || plan == nil || plan.Status != "draft" || len(plan.Stages) != 1 || plan.Stages[0].ModuleVersionID != stage.ModuleVersionID {
				t.Fatal("canonical draft plan missing")
			}
			replay, bad := c.call("task_submit", m11w5Args(task, id, output))
			if bad || !reflect.DeepEqual(got, replay) {
				t.Fatal("planner replay changed")
			}
			m11w5AssertNoHumanTools(t, c)
		})
	}
}

func TestM11W5PlatformPlannerForeignAttempt(t *testing.T) {
	p, ctx, item, session, stage := m10PlanFixture(t)
	m11w5Artifacts(t, p)
	m11w5Ready(t, p, ctx, item.WorkspaceID)
	first, err := p.CreateAuthor(ctx, item.ID, session.ID, "first plan", session.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	c := m11w5ClientFor(t, p, item.WorkspaceID)
	task := c.claim(first.Run.ID, "usecase-planner")
	proposed, bad := c.call("task_tool_call", m11w5Tool(task, "propose_plan", map[string]any{"stages": []PlanStageInput{stage}}))
	ref, ok := proposed["candidateRef"].(string)
	if bad || !ok || !ValidID(ref) {
		t.Fatal("first candidate not issued")
	}
	if _, bad = c.call("task_submit", m11w5Args(task, NewID(), map[string]any{"message": "first", "planCandidate": map[string]any{"candidateRef": ref}})); bad {
		t.Fatal("first plan submission failed")
	}
	second, err := p.CreatePlatformTest(ctx, item.WorkspaceID, "second", "", "usecase", nil)
	if err != nil {
		t.Fatal(err)
	}
	editing, _, err := p.StartEditingSession(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := p.CreateAuthor(ctx, second.ID, editing.ID, "second plan", editing.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	other := c.claim(sub.Run.ID, "usecase-planner")
	_, bad = c.call("task_submit", m11w5Args(other, NewID(), map[string]any{"message": "second", "planCandidate": map[string]any{"candidateRef": ref}}))
	plan, err := p.Plan(ctx, second.ID, editing.ID)
	if err != nil || plan != nil {
		t.Fatal("foreign attempt candidate applied", err)
	}
	m11w5RejectedOrFailed(t, p, ctx, sub.Run.ID, bad)
}

func TestM11W5PlatformWorkspace(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "stale"}[stale], func(t *testing.T) {
			p, ctx := workspaceTestDB(t)
			if err := p.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			m11w5Artifacts(t, p)
			w, err := p.CreateWorkspace(ctx, "workspace fixture")
			if err != nil {
				t.Fatal(err)
			}
			w, err = p.SetAuthorEngine(ctx, w.ID, w.Revision, "external")
			if err != nil {
				t.Fatal(err)
			}
			conv, err := p.WorkspaceConversation(ctx, w.ID)
			if err != nil {
				t.Fatal(err)
			}
			sub, err := p.CreateWorkspaceAuthor(ctx, w.ID, "Propose scope", w.Revision, conv.ContextRevision)
			if err != nil {
				t.Fatal(err)
			}
			if sub.Run.AuthorEngine != "external" || sub.Run.TestID != nil || sub.Run.EditingSessionID != nil {
				t.Fatal("workspace routing wrong")
			}
			c := m11w5ClientFor(t, p, w.ID)
			task := c.claim(sub.Run.ID, "workspace-author")
			if _, bad := c.call("task_tool_call", m11w5Tool(task, "browser_snapshot", map[string]any{})); !bad {
				t.Fatal("unconfirmed scope allowed browser")
			}
			cfg := WorkspaceConfig{Name: "workspace fixture", Targets: []WorkspaceOrigin{{Name: "synthetic", Origin: "https://m11.invalid"}}, Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{}, TimeoutMS: 15000}
			output := map[string]any{"message": "pending proposal", "proposal": cfg}
			if stale {
				if _, err = p.SetAuthorEngine(ctx, w.ID, w.Revision, "builtin"); err != nil {
					t.Fatal(err)
				}
			}
			id := NewID()
			got, bad := c.call("task_submit", m11w5Args(task, id, output))
			current, err := p.Workspace(ctx, w.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stale {
				if current.CurrentProposal != nil {
					t.Fatal("stale proposal applied")
				}
				m11w5RejectedOrFailed(t, p, ctx, sub.Run.ID, bad)
				return
			}
			if bad || got["state"] != "submitted" || got["appliedRevision"] != nil || got["validationRunId"] != nil || current.CurrentProposal == nil || current.CurrentProposal.Status != "pending" || current.CurrentProposal.ScopeConfirmed || current.Settings != nil {
				run, e := p.Run(ctx, sub.Run.ID)
				category := "other"
				switch run.Error {
				case "Workspace interview input was invalid.":
					category = "input_invalid"
				case "scope_confirmation_required: the interview scope was revoked.":
					category = "scope_revoked"
				case "Workspace settings or conversation changed; this result was not applied.":
					category = "revision_changed"
				case "Workspace interview output was invalid; saved settings are unchanged.":
					category = "output_invalid"
				case "":
					category = "empty"
				}
				var assistants, proposals int
				if q := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM messages WHERE run_id=$1 AND role='assistant'`, sub.Run.ID).Scan(&assistants); q != nil {
					t.Fatal(q)
				}
				if q := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM workspace_proposals WHERE source_run_id=$1`, sub.Run.ID).Scan(&proposals); q != nil {
					t.Fatal(q)
				}
				t.Fatalf("workspace result: rejected=%v submitted=%v appliedNil=%v validationNil=%v run=%s category=%s runErr=%v assistants=%d proposals=%d pending=%v settingsNil=%v", bad, got["state"] == "submitted", got["appliedRevision"] == nil, got["validationRunId"] == nil, run.Status, category, e != nil, assistants, proposals, current.CurrentProposal != nil, current.Settings == nil)
			}
			replay, bad := c.call("task_submit", m11w5Args(task, id, output))
			if bad || !reflect.DeepEqual(got, replay) {
				t.Fatal("workspace replay changed")
			}
		})
	}
}
