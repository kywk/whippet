//go:build integration && m10bridge

package server

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestM106PlatformServerBridge(t *testing.T) { runM106PlatformServerBridge(t, false) }
func TestM106LiveModelServerBridge(t *testing.T) {
	if os.Getenv("WHIPPET_M106_LIVE_MODEL") != "1" {
		t.Skip("requires PM-injected isolated live model environment")
	}
	for _, key := range []string{"WHIPPET_AI_ENABLED", "WHIPPET_AI_BASE_URL", "WHIPPET_AI_MODEL", "WHIPPET_AI_REASONING_EFFORT", "OPENCODE_API_KEY"} {
		if os.Getenv(key) == "" {
			t.Skip("requires complete PM-injected model configuration")
		}
	}
	runM106PlatformServerBridge(t, true)
}
func runM106PlatformServerBridge(t *testing.T, live bool) {
	p, ctx, item, editing, stage := m10PlanFixture(t)
	if live {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.WithoutCancel(ctx), 4*time.Minute)
		defer cancel()
	}
	inputAuthor, registry := m10PlatformInput(t, "usecase-planner")
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
	inputAuthor.AllowedTools = []string{"catalog_search", "catalog_next_page", "catalog_get", "propose_plan"}
	inputAuthor.Budget.MaxModelRequests = 4
	if live {
		if err = snapshotAuthor(&inputAuthor); err != nil {
			t.Fatal("live snapshot could not match configured backend", err)
		}
		if inputAuthor.Model.ReasoningEffort != os.Getenv("WHIPPET_AI_REASONING_EFFORT") {
			t.Fatal("live reasoning configuration must match manifest")
		}
		inputAuthor.Messages = []ChatMessage{{Role: "user", Content: "請先搜尋目前 Workspace 的已發佈 setup Module，再讀取搜尋結果的固定版本。為此 Use Case 提出只有一個 reuse Stage 的 Plan，沿用該固定版本，不建立或修改 Module，不確認、不排程、不發佈。完成後簡短說明已提案。"}}
	}
	if validateToolSnapshot(inputAuthor, registry, "propose_plan") != nil {
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
	server := httptest.NewTLSServer(observeBridgeTools(t, NewAPI(p, files, engine, token, log).Handler(nil), registry, item.WorkspaceID))
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
	if live {
		testName = "^TestM106LiveModelServerBridge$"
	}
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
	callsInput := []any{map[string]any{"name": "catalog_search", "arguments": map[string]any{"query": "setup", "limit": 1}}, map[string]any{"name": "catalog_get", "arguments": map[string]any{"moduleVersionId": stage.ModuleVersionID}}, map[string]any{"name": "propose_plan", "arguments": map[string]any{"stages": []PlanStageInput{stage}}}}
	if err = os.WriteFile(callPath, []byte(jsonText(callsInput)), 0600); err != nil {
		t.Fatal(err)
	}
	cmd.Env = append(cmd.Env, "WHIPPET_M10_BRIDGE_RESULT="+resultPath, "WHIPPET_M106_BRIDGE_CALLS="+callPath)
	if live {
		// Only PM's explicitly injected execution configuration is forwarded; never
		// read deployment files, credentials stores, or unrelated process/container env.
		for _, key := range []string{"WHIPPET_AI_ENABLED", "WHIPPET_AI_BASE_URL", "WHIPPET_AI_MODEL", "WHIPPET_AI_REASONING_EFFORT", "OPENCODE_API_KEY"} {
			if value := os.Getenv(key); value != "" {
				cmd.Env = append(cmd.Env, key+"="+value)
			}
		}
		cmd.Env = append(cmd.Env, "WHIPPET_M106_LIVE_MODEL=1", "WHIPPET_M106_EXPECT_VERSION="+stage.ModuleVersionID)
	}

	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("isolated Manager bridge failed: %v\n%s", err, output)
	}
	if strings.Contains(string(output), "SKIP") {
		t.Fatalf("bridge skipped: %s", output)
	}
	var calls int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM platform_tool_calls WHERE run_id=$1`, a.ID).Scan(&calls); err != nil || (!live && calls != 3) || (live && calls < 3) {
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
	plan, err := p.Plan(ctx, item.ID, editing.ID)
	if err != nil || plan == nil || plan.Status != "draft" || len(plan.Stages) != 1 || plan.Stages[0].ModuleVersionID != stage.ModuleVersionID {
		t.Fatal("canonical plan missing", err)
	}
	var scheduled int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind!='author'`, item.ID).Scan(&scheduled); err != nil || scheduled != 0 {
		t.Fatal("planner scheduled execution", err)
	}
	if plan.Stages[0].Action != "reuse" {
		t.Fatal("planner did not reuse fixed version")
	}
	if live {
		t.Log("live model -> Node -> Manager -> TLS Server -> PG canonical fixed-version reuse draft; no execution queued; no SKIP")
	} else {
		t.Log("real Node -> Manager -> TLS -> Server tools -> PG: 3 calls, artifact upload, canonical candidate CAS; synthetic provider; no SKIP")
	}
	t.Log(string(output))
}
