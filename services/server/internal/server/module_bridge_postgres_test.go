//go:build integration && m10bridge

package server

import (
	"bytes"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestM106ModuleServerBridge(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "Module bridge")
	if err != nil {
		t.Fatal(err)
	}
	config := WorkspaceConfig{Name: "module", Purpose: "synthetic", BackgroundSummary: "synthetic", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://example.test", Purpose: "test"}}}
	config, err = normalizeConfig(config, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, w.ID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	slug := "setup"
	item, err := p.CreatePlatformTest(ctx, w.ID, "Module", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	editing, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	inputAuthor, registry := m10PlatformInput(t, "module-authoring")
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	d, s, err := requireEditingDraft(ctx, tx, item.ID, editing.ID)
	if err != nil {
		t.Fatal(err)
	}
	inputAuthor.EditingSessionID = s.ID
	inputAuthor.ConversationID = s.ConversationID
	inputAuthor.BaseRevision = d.Revision
	inputAuthor.ContextRevision = s.ContextRevision
	inputAuthor.Messages = []ChatMessage{{Role: "user", Content: "Build the synthetic plan"}}
	inputAuthor.Platform.Module = &Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare"}
	inputAuthor.AllowedTools = []string{"update_module_candidate", "request_module_validation"}
	inputAuthor.Budget.MaxModelRequests = 4
	if validateToolSnapshot(inputAuthor, registry, "update_module_candidate") != nil {
		t.Fatal("invalid fixture snapshot")
	}
	run, err := enqueueAuthorSnapshot(ctx, tx, d, inputAuthor)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	runID := run.ID
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	defer engine.Close()
	session, err := engine.Attach(ctx, "m10-bridge", 1, &recordPeer{})
	if err != nil {
		t.Fatal(err)
	}
	if err = engine.Handle(ctx, session, NewEnvelope("heartbeat", "m10-bridge", "", "", struct {
		Active []ActiveAttempt `json:"active"`
	}{[]ActiveAttempt{}})); err != nil {
		t.Fatal(err)
	}
	if err = engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	assignments, err := p.Assignments(ctx, "m10-bridge")
	if err != nil || len(assignments) != 1 || assignments[0].ID != runID {
		t.Fatal("isolated assignment missing", err)
	}
	a := assignments[0]
	token := "synthetic-m10-isolated-bridge-token"
	server := httptest.NewTLSServer(NewAPI(p, files, engine, token, log).Handler(nil))
	defer server.Close()
	temp := t.TempDir()
	ca := filepath.Join(temp, "public-ca.pem")
	input := filepath.Join(temp, "input.json")
	if err = os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	wire := map[string]any{"runId": a.ID, "attemptId": a.AttemptID, "kind": "author", "script": a.Script, "timeoutMs": a.TimeoutMS, "workspaceId": a.WorkspaceID, "testId": a.TestID, "workspaceContext": a.WorkspaceContext, "workspaceSettings": a.WorkspaceSettings, "scriptOrigin": a.ScriptOrigin, "author": a.Author}
	if err = os.WriteFile(input, []byte(jsonText(wire)), 0600); err != nil {
		t.Fatal(err)
	}
	goCommand := os.Getenv("WHIPPET_M10_MANAGER_GO")
	if goCommand == "" {
		goCommand = "go"
	}
	testName := "^TestM106PlatformServerBridge$"
	cmd := exec.CommandContext(ctx, goCommand, "test", "./internal/manager", "-run", testName, "-count=1", "-v")
	cmd.Dir = repositoryFile("services", "manager")
	// Do not pass database, provider or real Manager secrets to the subprocess.
	for _, name := range []string{"PATH", "HOME", "TMPDIR", "LANG"} {
		if value := os.Getenv(name); value != "" {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off", "GOCACHE=/private/tmp/whippet-m10-go-cache",
		"WHIPPET_M10_BRIDGE_URL="+server.URL, "WHIPPET_M10_BRIDGE_CA="+ca, "WHIPPET_M10_BRIDGE_TOKEN="+token, "WHIPPET_M10_BRIDGE_INPUT="+input,
		"WHIPPET_M10_WORKER_ENTRY="+repositoryFile("runtimes", "worker", "dist", "author", "main.js"))
	resultPath := filepath.Join(temp, "handoff.json")
	callPath := filepath.Join(temp, "calls.json")
	module := *inputAuthor.Platform.Module
	module.Harness = "import {test,expect} from '@playwright/test'; import {prepare} from '@lib/setup'; test('module',async()=>{expect(await prepare({})).toEqual({name:'alpha'});});"
	callsInput := []any{map[string]any{"name": "update_module_candidate", "arguments": map[string]any{"script": "export async function prepare(_args:any){return {name:'alpha'};}", "module": module}}, map[string]any{"name": "request_module_validation", "arguments": map[string]any{}}}
	if err = os.WriteFile(callPath, []byte(jsonText(callsInput)), 0600); err != nil {
		t.Fatal(err)
	}
	cmd.Env = append(cmd.Env, "WHIPPET_M10_BRIDGE_RESULT="+resultPath, "WHIPPET_M106_BRIDGE_CALLS="+callPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("isolated Manager bridge failed: %v\n%s", err, output)
	}
	if strings.Contains(string(output), "SKIP") {
		t.Fatalf("bridge skipped: %s", output)
	}
	var calls int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM platform_tool_calls WHERE run_id=$1`, a.ID).Scan(&calls); err != nil || calls != 0 {
		t.Fatal("real tools count", calls, err)
	}
	var handoff struct {
		RunID            string `json:"runId"`
		AttemptID        string `json:"attemptId"`
		Result           Result `json:"result"`
		ArtifactUploaded bool   `json:"artifactUploaded"`
	}
	data, err := os.ReadFile(resultPath)
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(data, &handoff) != nil || handoff.RunID != a.ID || handoff.AttemptID != a.AttemptID || handoff.Result.Status != "succeeded" || !handoff.ArtifactUploaded {
		t.Fatal("invalid platform handoff")
	}
	if err = engine.Handle(ctx, session, NewEnvelope("result", "m10-bridge", a.ID, a.AttemptID, handoff.Result)); err != nil {
		t.Fatal(err)
	}
	completed, err := p.Run(ctx, a.ID)
	if err != nil || completed.Status != "succeeded" {
		t.Fatal("planner completion", completed.Status, err)
	}
	var count int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='validation'`, item.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("early validation", err)
	}
	if err = engine.Handle(ctx, session, NewEnvelope("heartbeat", "m10-bridge", "", "", struct {
		Active []ActiveAttempt `json:"active"`
	}{[]ActiveAttempt{}})); err != nil {
		t.Fatal(err)
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='validation'`, item.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("missing reclaimed validation", err)
	}
	validation, err := p.Claim(ctx, "m10-bridge", 1)
	if err != nil || validation == nil || len(validation.Files) != 2 {
		t.Fatal("formal bundle missing", err)
	}
	validationDir := t.TempDir()
	validationInput := map[string]any{"runId": validation.ID, "attemptId": validation.AttemptID, "script": validation.Script, "files": validation.Files, "timeoutMs": validation.TimeoutMS, "workspaceId": validation.WorkspaceID, "testId": validation.TestID, "workspaceContext": validation.WorkspaceContext, "workspaceSettings": validation.WorkspaceSettings, "scriptOrigin": validation.ScriptOrigin}
	if err = os.WriteFile(filepath.Join(validationDir, "input.json"), []byte(jsonText(validationInput)), 0600); err != nil {
		t.Fatal(err)
	}
	runner := exec.CommandContext(ctx, "node", repositoryFile("runtimes", "worker", "dist", "runner.js"))
	for _, key := range []string{"PATH", "HOME", "TMPDIR", "LANG"} {
		if value := os.Getenv(key); value != "" {
			runner.Env = append(runner.Env, key+"="+value)
		}
	}
	runner.Env = append(runner.Env, "WHIPPET_WORK_DIR="+validationDir)
	runtimeOutput, err := runner.CombinedOutput()
	if err != nil {
		t.Fatalf("formal runner failed: %v (output bytes=%d)", err, len(runtimeOutput))
	}
	for _, name := range []string{"report.html", "results.json"} {
		body, e := os.ReadFile(filepath.Join(validationDir, "output", name))
		if e != nil {
			t.Fatal(e)
		}
		request, e := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/manager/runs/"+validation.ID+"/artifacts/"+name, bytes.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-Attempt-Id", validation.AttemptID)
		response, e := server.Client().Do(request)
		if e != nil {
			t.Fatal(e)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("formal report upload", response.StatusCode)
		}
	}
	resultBytes, err := os.ReadFile(filepath.Join(validationDir, "output", "result.json"))
	if err != nil {
		t.Fatal(err)
	}
	var formal Result
	if json.Unmarshal(resultBytes, &formal) != nil || formal.Status != "succeeded" {
		t.Fatal("formal validation failed")
	}
	if err = engine.Handle(ctx, session, NewEnvelope("result", "m10-bridge", validation.ID, validation.AttemptID, formal)); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "m10-bridge", nil); err != nil {
		t.Fatal(err)
	}
	t.Log("formal Node runner executed pinned Module body+harness; real HTML/JSON uploaded through TLS Server; PG validation succeeded and reclaimed; pure-computation assertion")
	t.Log("real Node dual-file self-test -> Manager parser/upload -> TLS Server -> PG Module CAS -> reclaim -> one formal validation; synthetic provider; no SKIP")
	t.Log(string(output))
}
