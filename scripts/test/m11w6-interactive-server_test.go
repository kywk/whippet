//go:build integration

// Real MCP HTTP handler and disposable PostgreSQL schemas. Any synthetic
// published Module or validation state is not Docker, UI, or model evidence.
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
	"time"
)

type w6Client struct {
	t      *testing.T
	h      http.Handler
	token  AgentToken
	secret string
	last   time.Time
}

func w6ClientFor(t *testing.T, p *Postgres, workspace string) *w6Client {
	t.Helper()
	token, secret, err := p.CreateAgentToken(context.Background(), workspace, "isolated QA")
	if err != nil {
		t.Fatal("create token failed")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &w6Client{t: t, h: NewAPI(p, nil, NewEngine(p, logger), NewID(), logger).WithAdminAccess(NewID(), "https://whippet.example").Handler(nil), token: token, secret: secret}
}
func (c *w6Client) request(method string, params any) (map[string]any, bool, int) {
	c.t.Helper()
	if wait := time.Until(c.last.Add(1050 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	c.last = time.Now()
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		c.t.Fatal("encode request failed")
	}
	req := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+c.secret)
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	if rec.Code == 429 || rec.Code >= 500 {
		c.t.Fatalf("inconclusive MCP HTTP status %d", rec.Code)
	}
	if rec.Code == 401 || rec.Code == 403 {
		return nil, true, rec.Code
	}
	if rec.Code != 200 && rec.Code != 400 {
		c.t.Fatalf("unexpected MCP HTTP status %d", rec.Code)
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
		return map[string]any{"names": names}, rec.Code != 200 || len(wire.Error) > 0, rec.Code
	}
	return wire.Result.Structured, rec.Code != 200 || wire.Result.IsError || len(wire.Error) > 0, rec.Code
}
func (c *w6Client) call(name string, args any) (map[string]any, bool) {
	r, b, _ := c.request("tools/call", map[string]any{"name": name, "arguments": args})
	return r, b
}
func w6Setup(t *testing.T) (*Postgres, context.Context, Workspace, *w6Client) {
	t.Helper()
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal("migration failed")
	}
	artifacts, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal("artifacts setup failed")
	}
	p.Artifacts = artifacts
	w, err := p.CreateWorkspace(ctx, "w6 isolated")
	if err != nil {
		t.Fatal("workspace setup failed")
	}
	cfg := WorkspaceConfig{Name: "fixture", Targets: []WorkspaceOrigin{{Name: "fixture", Origin: "https://m11.invalid"}}, Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{}, TimeoutMS: 15000}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,canonical_config=$2 WHERE id=$1`, w.ID, jsonText(cfg)); err != nil {
		t.Fatal("scope fixture failed")
	}
	return p, ctx, w, w6ClientFor(t, p, w.ID)
}
func w6Create(t *testing.T, c *w6Client, kind string) (map[string]any, map[string]any) {
	t.Helper()
	args := map[string]any{"requestId": NewID(), "kind": kind, "name": "Synthetic " + kind, "description": "isolated fixture"}
	if kind == "module" {
		args["slug"] = "synthetic"
	}
	r, b := c.call("draft_create", args)
	if b || !ValidID(asString(r["testId"])) || !ValidID(asString(r["editingSessionId"])) {
		t.Fatalf("%s create failed", kind)
	}
	return r, args
}
func asString(v any) string { s, _ := v.(string); return s }
func w6StartArgs(d map[string]any) map[string]any {
	return map[string]any{"requestId": NewID(), "testId": d["testId"], "editingSessionId": d["editingSessionId"], "revision": d["revision"], "contextRevision": d["contextRevision"], "instruction": "Prepare a synthetic candidate"}
}
func w6TaskArgs(task map[string]any) map[string]any {
	return map[string]any{"runId": task["runId"], "attemptId": task["attemptId"], "leaseId": task["leaseId"]}
}
func w6Tool(task map[string]any, name string, args any) map[string]any {
	a := w6TaskArgs(task)
	a["callId"] = NewID()
	a["name"] = name
	a["arguments"] = args
	return a
}
func w6Submit(task map[string]any, output any) map[string]any {
	a := w6TaskArgs(task)
	a["submitId"] = NewID()
	a["output"] = output
	return a
}
func w6Start(t *testing.T, c *w6Client, d map[string]any) (map[string]any, map[string]any) {
	t.Helper()
	args := w6StartArgs(d)
	r, b := c.call("author_start", args)
	task, ok := r["task"].(map[string]any)
	if b || !ok || !ValidID(asString(task["runId"])) {
		t.Fatal("interactive author_start failed")
	}
	return task, args
}

func TestM11W6InteractiveModule(t *testing.T) {
	p, ctx, w, c := w6Setup(t)
	before, err := p.Workspace(ctx, w.ID)
	if err != nil {
		t.Fatal("read engine failed")
	}
	d, create := w6Create(t, c, "module")
	replay, b := c.call("draft_create", create)
	if b || !reflect.DeepEqual(d, replay) {
		t.Fatal("create replay mismatch")
	}
	changed := map[string]any{}
	for k, v := range create {
		changed[k] = v
	}
	changed["name"] = "other"
	if _, b = c.call("draft_create", changed); !b {
		t.Fatal("changed create replay accepted")
	}
	got, b := c.call("draft_get", map[string]any{"testId": d["testId"]})
	if b || got["test"] == nil || got["draft"] == nil || got["editingSession"] == nil || got["plan"] != nil {
		t.Fatal("draft_get projection incomplete")
	}
	task, start := w6Start(t, c, d)
	started, b := c.call("author_start", start)
	t2, ok := started["task"].(map[string]any)
	if b || !ok || t2["runId"] != task["runId"] {
		t.Fatal("author_start replay mismatch")
	}
	peer := w6ClientFor(t, p, w.ID)
	if _, denied := peer.call("task_tool_call", w6Tool(task, "read_module_draft", map[string]any{})); !denied {
		t.Fatal("another Token accessed the author lease")
	}
	var beforeBusy, afterBusy int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1`, d["testId"]).Scan(&beforeBusy); err != nil {
		t.Fatal("count runs failed")
	}
	if _, denied := c.call("author_start", w6StartArgs(d)); !denied {
		t.Fatal("active claim did not block another author_start")
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1`, d["testId"]).Scan(&afterBusy); err != nil || beforeBusy != afterBusy {
		t.Fatal("busy author_start created an orphan Run")
	}
	if _, b = c.call("task_tool_call", w6Tool(task, "read_module_draft", map[string]any{})); b {
		t.Fatal("interactive task read failed")
	}
	meta := Module{Slug: "synthetic", ModuleKind: "step", ExportName: "prepare", Harness: "import {test,expect} from '@playwright/test'; import {prepare} from '@lib/synthetic'; test('module',async()=>{expect(await prepare({})).toEqual({name:'alpha'});});"}
	output := map[string]any{"message": "candidate", "script": "export async function prepare(_args:any){return {name:'alpha'};}", "module": meta, "requestValidation": false}
	submit := w6Submit(task, output)
	submitted, b := c.call("task_submit", submit)
	if b || submitted["state"] != "submitted" {
		t.Fatal("interactive submit failed")
	}
	draft, err := p.Draft(ctx, asString(d["testId"]))
	if err != nil || draft.ScriptOrigin != "ai" || draft.Script != output["script"] {
		t.Fatal("AI candidate missing")
	}
	req := map[string]any{"requestId": NewID(), "testId": d["testId"], "editingSessionId": d["editingSessionId"], "revision": draft.Revision}
	validation, b := c.call("validation_request", req)
	if b || validation["state"] != "queued" || !ValidID(asString(validation["runId"])) {
		t.Fatal("formal validation was not queued")
	}
	again, b := c.call("validation_request", req)
	if b || !reflect.DeepEqual(validation, again) {
		t.Fatal("validation replay mismatch")
	}
	report, b := c.call("validation_report", map[string]any{"testId": d["testId"], "revision": draft.Revision, "runId": validation["runId"]})
	if b || report == nil {
		t.Fatal("queued report unavailable")
	}
	raw, _ := json.Marshal(report)
	if strings.Contains(strings.ToLower(string(raw)), "succeeded") {
		t.Fatal("unfinished report claimed success")
	}
	if _, b = c.call("validation_report", map[string]any{"testId": d["testId"], "revision": draft.Revision + 1, "runId": validation["runId"]}); !b {
		t.Fatal("wrong report revision accepted")
	}
	// Synthetic result fixture verifies report projection only; it is not worker evidence.
	if err = p.RegisterManager(ctx, "m11w6-synthetic", 1); err != nil {
		t.Fatal("synthetic manager fixture failed")
	}
	a, err := p.Claim(ctx, "m11w6-synthetic", 1)
	if err != nil || a == nil || a.ID != validation["runId"] {
		t.Fatal("synthetic validation claim failed")
	}
	files, ok := p.Artifacts.(*LocalArtifacts)
	if !ok {
		t.Fatal("fixture artifacts unavailable")
	}
	for name, content := range map[string]string{"report.html": "<html>synthetic</html>", "results.json": `{"stats":{"expected":0,"unexpected":1,"flaky":0,"skipped":0,"duration":1},"errors":[{"message":"untrusted-log-sentinel"}]}`} {
		item, e := files.Save(a.ID, a.AttemptID, name, strings.NewReader(content))
		if e != nil {
			t.Fatal("synthetic artifact failed")
		}
		if e = p.SaveArtifact(ctx, item); e != nil {
			t.Fatal("synthetic artifact metadata failed")
		}
	}
	if err = p.Complete(ctx, "m11w6-synthetic", a.ID, a.AttemptID, Result{Status: "failed"}); err != nil {
		t.Fatal("synthetic completion failed")
	}
	finished, rejected := c.call("validation_report", map[string]any{"testId": d["testId"], "revision": draft.Revision, "runId": validation["runId"]})
	projection, ok := finished["report"].(map[string]any)
	raw, _ = json.Marshal(finished)
	if rejected || finished["status"] != "failed" || !ok || projection["errorCount"] != float64(1) || strings.Contains(string(raw), "untrusted-log-sentinel") {
		t.Fatal("completed report was not safely projected")
	}
	completedReplay, rejected := c.call("validation_request", req)
	if rejected || !reflect.DeepEqual(validation, completedReplay) {
		t.Fatal("completed validation replay changed")
	}
	after, err := p.Workspace(ctx, w.ID)
	if err != nil || before.AuthorEngine != after.AuthorEngine {
		t.Fatal("workspace engine changed")
	}
}

func TestM11W6InteractivePlanAndBoundaries(t *testing.T) {
	p, ctx, w, c := w6Setup(t)
	// Seed only a published dependency so the planner can propose a real Plan.
	slug := "fixture"
	module, err := p.CreatePlatformTest(ctx, w.ID, "dependency", "", "module", &slug)
	if err != nil {
		t.Fatal("dependency fixture failed")
	}
	ws, err := p.Workspace(ctx, w.ID)
	if err != nil {
		t.Fatal("workspace fixture failed")
	}
	version := NewID()
	metadata := Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare", Harness: m10BundleSpec}
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings,module,script_origin) VALUES($1,$2,1,$3,60000,$4,$5,'manual')`, version, module.ID, m10BundleModule, settingsJSON(&ws.WorkspaceSettings), jsonText(metadata)); err != nil {
		t.Fatal("dependency version fixture failed")
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, module.ID, version); err != nil {
		t.Fatal("dependency publication fixture failed")
	}
	d, _ := w6Create(t, c, "usecase")
	task, _ := w6Start(t, c, d)
	stage := PlanStageInput{ID: "prepare", Title: "Prepare", Action: "reuse", ModuleVersionID: version, Args: map[string]StageArgument{}}
	proposal, b := c.call("task_tool_call", w6Tool(task, "propose_plan", map[string]any{"stages": []PlanStageInput{stage}}))
	ref := asString(proposal["candidateRef"])
	if b || !ValidID(ref) {
		t.Fatal("interactive propose_plan failed")
	}
	submit := w6Submit(task, map[string]any{"message": "draft plan", "planCandidate": map[string]any{"candidateRef": ref}})
	if r, b := c.call("task_submit", submit); b || r["state"] != "submitted" {
		t.Fatal("plan submit failed")
	}
	plan, err := p.Plan(ctx, asString(d["testId"]), asString(d["editingSessionId"]))
	if err != nil || plan == nil || plan.Status != "draft" {
		t.Fatal("unconfirmed draft plan missing")
	}
	req := map[string]any{"requestId": NewID(), "testId": d["testId"], "editingSessionId": d["editingSessionId"], "revision": d["revision"]}
	waiting, b := c.call("validation_request", req)
	if b || waiting["state"] != "awaiting_human_plan_confirmation" || waiting["runId"] != nil {
		t.Fatal("unconfirmed plan did not wait")
	}
	var waitingRecords int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM agent_interactive_operations WHERE token_id=$1 AND tool_name='validation_request' AND request_id=$2`, c.token.ID, req["requestId"]).Scan(&waitingRecords); err != nil || waitingRecords != 0 {
		t.Fatal("waiting result left a permanent operation record")
	}
	// This simulates the human-only API action, never an MCP operation.
	confirmed, err := p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil || confirmed == nil {
		t.Fatal("human confirmation fixture failed")
	}
	current, err := p.Draft(ctx, asString(d["testId"]))
	if err != nil {
		t.Fatal("draft read after human confirmation failed")
	}
	req["revision"] = current.Revision // confirmation may advance the revision; preserve requestId.
	queued, b := c.call("validation_request", req)
	if b || queued["state"] != "queued" || !ValidID(asString(queued["runId"])) {
		t.Fatal("waiting result prevented same-key request after confirmation")
	}
	again, b := c.call("validation_request", req)
	if b || !reflect.DeepEqual(queued, again) {
		t.Fatal("confirmed validation replay mismatch")
	}
	names, b, _ := c.request("tools/list", map[string]any{})
	if b {
		t.Fatal("tools/list failed")
	}
	for _, name := range names["names"].([]string) {
		if strings.Contains(name, "confirm") || strings.Contains(name, "publish") {
			t.Fatal("human action exposed as MCP tool")
		}
	}
	other, err := p.CreateWorkspace(ctx, "other workspace")
	if err != nil {
		t.Fatal("other workspace setup failed")
	}
	foreign := w6ClientFor(t, p, other.ID)
	if _, b = foreign.call("draft_get", map[string]any{"testId": d["testId"]}); !b {
		t.Fatal("cross-workspace read accepted")
	}
	if _, b = foreign.call("validation_report", map[string]any{"testId": d["testId"], "revision": current.Revision, "runId": queued["runId"]}); !b {
		t.Fatal("cross-workspace report accepted")
	}
	if err = p.RevokeAgentToken(ctx, w.ID, c.token.ID); err != nil {
		t.Fatal("token revoke failed")
	}
	_, denied, status := c.request("tools/call", map[string]any{"name": "draft_get", "arguments": map[string]any{"testId": d["testId"]}})
	if !denied || (status != 401 && status != 403) {
		t.Fatal("revoked token was not explicitly rejected")
	}
}

func TestM11W6InteractiveStaleCAS(t *testing.T) {
	p, ctx, _, c := w6Setup(t)
	d, _ := w6Create(t, c, "module")
	stale := w6StartArgs(d)
	_, err := p.SaveDraft(ctx, asString(d["testId"]), asString(d["editingSessionId"]), int(d["revision"].(float64)), "// human edit")
	if err != nil {
		t.Fatal("human edit fixture failed")
	}
	if _, b := c.call("author_start", stale); !b {
		t.Fatal("stale author_start accepted")
	}
	after, err := p.Draft(ctx, asString(d["testId"]))
	if err != nil || after.Script != "// human edit" {
		t.Fatal("stale author_start overwrote human edit")
	}
}

func TestM11W6InteractiveStaleSubmit(t *testing.T) {
	p, ctx, _, c := w6Setup(t)
	d, _ := w6Create(t, c, "module")
	task, _ := w6Start(t, c, d)
	_, err := p.SaveDraft(ctx, asString(d["testId"]), asString(d["editingSessionId"]), int(d["revision"].(float64)), "// human later edit")
	if err != nil {
		t.Fatal("human edit fixture failed")
	}
	meta := Module{Slug: "synthetic", ModuleKind: "step", ExportName: "prepare", Harness: "import {test} from '@playwright/test'; test('fixture',async()=>{});"}
	out := map[string]any{"message": "candidate", "script": "export async function prepare(){}", "module": meta, "requestValidation": true}
	_, rejected := c.call("task_submit", w6Submit(task, out))
	after, err := p.Draft(ctx, asString(d["testId"]))
	if err != nil || after.Script != "// human later edit" || after.ValidationRunID != nil {
		t.Fatal("stale submit overwrote human edit or queued validation")
	}
	run, err := p.Run(ctx, asString(task["runId"]))
	if err != nil || (!rejected && run.Status != "failed") || run.Status == "succeeded" {
		t.Fatal("stale submit neither rejected nor failed")
	}
}
