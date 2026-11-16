//go:build integration

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestM11InteractiveMCPAuthorAndWaitingPlan(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "interactive")
	if err != nil {
		t.Fatal(err)
	}
	config := WorkspaceConfig{Name: "interactive", Targets: []WorkspaceOrigin{{Name: "synthetic", Origin: "https://m11.invalid"}}, Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{}, TimeoutMS: 15000}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,canonical_config=$2 WHERE id=$1`, w.ID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	token, secret, err := p.CreateAgentToken(ctx, w.ID, "interactive")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAPI(p, nil, nil, NewID(), slog.New(slog.NewTextHandler(io.Discard, nil))).WithAdminAccess(NewID(), "").Handler(nil)
	call := func(name string, args any) (map[string]any, bool) {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
		req := httptest.NewRequest(http.MethodPost, "http://whippet.invalid/mcp", bytes.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+secret)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		if out.Code != http.StatusOK {
			t.Fatalf("%s HTTP %d", name, out.Code)
		}
		var response struct {
			Result struct {
				IsError           bool           `json:"isError"`
				StructuredContent map[string]any `json:"structuredContent"`
			} `json:"result"`
		}
		if err := json.Unmarshal(out.Body.Bytes(), &response); err != nil {
			t.Fatalf("%s invalid MCP result: %v", name, err)
		}
		return response.Result.StructuredContent, response.Result.IsError
	}
	createID := NewID()
	createArgs := map[string]any{"requestId": createID, "kind": "module", "name": "MCP module", "description": "draft", "slug": "mcp-module"}
	created, failed := call("draft_create", createArgs)
	if failed || created["testId"] == nil {
		t.Fatalf("create: %+v", created)
	}
	duplicate, failed := call("draft_create", createArgs)
	if failed || duplicate["testId"] != created["testId"] {
		t.Fatal("create replay made another draft")
	}
	createArgs["name"] = "changed"
	if _, failed = call("draft_create", createArgs); !failed {
		t.Fatal("same requestId accepted different body")
	}
	testID := created["testId"].(string)
	get, failed := call("draft_get", map[string]any{"testId": testID})
	if failed || get["draft"].(map[string]any)["scriptOrigin"] != "ai" {
		t.Fatalf("draft projection: %+v", get)
	}
	start := map[string]any{"requestId": NewID(), "testId": testID, "editingSessionId": created["editingSessionId"], "revision": created["revision"], "contextRevision": created["contextRevision"], "instruction": "撰寫 Module 候選"}
	started, failed := call("author_start", start)
	if failed {
		t.Fatal("author_start failed")
	}
	task := started["task"].(map[string]any)
	run, err := p.Run(ctx, task["runId"].(string))
	if err != nil || run.AuthorEngine != "external" || run.Status != "running" {
		t.Fatalf("run not directly claimed: %+v %v", run, err)
	}
	replayed, failed := call("author_start", start)
	if failed || replayed["task"].(map[string]any)["runId"] != task["runId"] {
		t.Fatal("author replay changed task")
	}
	if _, failed = call("author_start", map[string]any{"requestId": NewID(), "testId": testID, "editingSessionId": created["editingSessionId"], "revision": created["revision"], "contextRevision": created["contextRevision"], "instruction": "another"}); !failed {
		t.Fatal("active claim allowed orphan author Run")
	}
	var runs int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='author'`, testID).Scan(&runs); err != nil || runs != 1 {
		t.Fatalf("orphan run count %d: %v", runs, err)
	}
	other, _, err := p.CreateAgentToken(ctx, w.ID, "other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.HeartbeatExternalAuthor(ctx, other, task["runId"].(string), task["attemptId"].(string), task["leaseId"].(string)); err == nil {
		t.Fatal("other Token used interactive claim")
	}
	usecase, failed := call("draft_create", map[string]any{"requestId": NewID(), "kind": "usecase", "name": "MCP usecase", "description": "draft"})
	if failed {
		t.Fatal("usecase create failed")
	}
	waitArgs := map[string]any{"requestId": NewID(), "testId": usecase["testId"], "editingSessionId": usecase["editingSessionId"], "revision": usecase["revision"]}
	waiting, failed := call("validation_request", waitArgs)
	if failed || waiting["state"] != "awaiting_human_plan_confirmation" {
		t.Fatalf("plan confirmation bypass: %+v", waiting)
	}
	var operations int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM agent_interactive_operations WHERE token_id=$1 AND tool_name='validation_request' AND request_id=$2`, token.ID, waitArgs["requestId"]).Scan(&operations); err != nil || operations != 0 {
		t.Fatal("waiting Plan left permanent tombstone")
	}
}
