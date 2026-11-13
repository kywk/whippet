//go:build integration && m10bridge

package server

import (
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Opt-in tag keeps this cross-runtime test separate from pure Server checks.
// PostgreSQL, API, TLS certificate, token and provider are all isolated fixtures.
func TestM10HarnessServerBridge(t *testing.T) { runM10ServerBridge(t, false) }
func TestM10PartialServerBridge(t *testing.T) { runM10ServerBridge(t, true) }
func runM10ServerBridge(t *testing.T, partial bool) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var runID string
	if partial {
		runID, _ = m10HistoryFixture(t, p, ctx, 1)
	} else {
		runID, _ = m10HistoryFixture(t, p, ctx)
	}
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
	testName := "^TestM10HarnessServerBridge$"
	if partial {
		testName = "^TestM10PartialServerBridge$"
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
	if partial {
		cmd.Env = append(cmd.Env, "WHIPPET_M10_BRIDGE_RESULT="+resultPath)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("isolated Manager bridge failed: %v\n%s", err, output)
	}
	if strings.Contains(string(output), "SKIP") || (!partial && !strings.Contains(string(output), "modelRequests=2 genericIPC=1 toolSuccess=1 toolFailure=0")) {
		t.Fatalf("bridge evidence missing: %s", output)
	}
	var calls int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM harness_history_calls WHERE run_id=$1 AND attempt_id=$2`, a.ID, a.AttemptID).Scan(&calls); err != nil || calls != 1 {
		t.Fatal("real Server/PG did not persist exactly one authorized call", err)
	}
	if partial {
		var handoff struct {
			RunID            string `json:"runId"`
			AttemptID        string `json:"attemptId"`
			Result           Result `json:"result"`
			ArtifactUploaded bool   `json:"artifactUploaded"`
			Partial          bool   `json:"partial"`
			Checkpoint       bool   `json:"checkpoint"`
		}
		data, err := os.ReadFile(resultPath)
		if err != nil {
			t.Fatal(err)
		}
		if json.Unmarshal(data, &handoff) != nil || handoff.RunID != a.ID || handoff.AttemptID != a.AttemptID || handoff.Result.Status != "succeeded" || !handoff.ArtifactUploaded || !handoff.Partial || handoff.Checkpoint {
			t.Fatal("invalid synthetic partial handoff")
		}
		if _, err = p.Artifact(ctx, a.ID, "author.json"); err != nil {
			t.Fatal("Manager artifact did not reach real Server", err)
		}
		if err = engine.Handle(ctx, session, NewEnvelope("result", "m10-bridge", a.ID, a.AttemptID, handoff.Result)); err != nil {
			t.Fatal(err)
		}
		completed, err := p.Run(ctx, a.ID)
		if err != nil || completed.Status != "succeeded" || completed.AuthorPartial == nil || completed.AuthorPartial.Checkpoint != nil {
			t.Fatal("real partial not persisted", err)
		}
		if _, err = p.ContinueAuthor(ctx, a.ID, a.Author.EditingSessionID, a.Author.BaseRevision); !errors.Is(err, ErrConflict) {
			t.Fatal("continued before Manager reclaim", err)
		}
		if err = engine.Handle(ctx, session, NewEnvelope("heartbeat", "m10-bridge", "", "", struct {
			Active []ActiveAttempt `json:"active"`
		}{[]ActiveAttempt{}})); err != nil {
			t.Fatal(err)
		}
		next, err := p.ContinueAuthor(ctx, a.ID, a.Author.EditingSessionID, a.Author.BaseRevision)
		if err != nil {
			t.Fatal(err)
		}
		repeated, err := p.ContinueAuthor(ctx, a.ID, a.Author.EditingSessionID, a.Author.BaseRevision)
		if err != nil || next.Run.ID != repeated.Run.ID {
			t.Fatal("duplicate continue requeued", err)
		}
		var count int
		if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM author_continuations WHERE source_run_id=$1`, a.ID).Scan(&count); err != nil || count != 1 {
			t.Fatal("continuation is not unique", err)
		}
		t.Log("real Node budget exhaustion -> Manager parser + HTTPS artifact upload -> Server partial persistence -> heartbeat reclaim -> one continued Run; identical request replays same Run; no SKIP")
		t.Log(string(output))
		return
	}
	t.Log("real Node author -> Manager toolChannel -> TLS -> Server ManagerAuth/harness handler -> PostgreSQL: 1 authorized history call; synthetic provider: 2 model requests, opaque call ID preserved, bridge-ok, no SKIP")
	t.Log(string(output))
}
