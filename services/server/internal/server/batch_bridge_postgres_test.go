//go:build integration && m10bridge

package server

import (
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
)

func TestM105BatchSummaryServerBridge(t *testing.T) {
	runM10PlanModuleFlow(t, "create", runM105BatchBridge)
}
func runM105BatchBridge(t *testing.T, p *Postgres, a *Assignment, files *LocalArtifacts) {
	runSummaryBridge(t, p, a, files, false)
}
func TestM10ModuleSummaryServerBridge(t *testing.T) {
	runM10ModuleSummary(t, "publish", func(t *testing.T, p *Postgres, a *Assignment, files *LocalArtifacts) {
		runSummaryBridge(t, p, a, files, true)
	})
}
func runSummaryBridge(t *testing.T, p *Postgres, a *Assignment, files *LocalArtifacts, module bool) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	defer engine.Close()
	token := "synthetic-m105-batch-token"
	server := httptest.NewTLSServer(NewAPI(p, files, engine, token, log).Handler(nil))
	defer server.Close()
	temp := t.TempDir()
	ca := filepath.Join(temp, "public-ca.pem")
	input := filepath.Join(temp, "input.json")
	result := filepath.Join(temp, "result.json")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	wire := map[string]any{"kind": "author", "runId": a.ID, "attemptId": a.AttemptID, "script": a.Script, "timeoutMs": a.TimeoutMS, "workspaceId": a.WorkspaceID, "testId": a.TestID, "workspaceSettings": a.WorkspaceSettings, "workspaceContext": a.WorkspaceContext, "scriptOrigin": a.ScriptOrigin, "author": a.Author}
	if err := os.WriteFile(input, []byte(jsonText(wire)), 0600); err != nil {
		t.Fatal(err)
	}
	goCommand := os.Getenv("WHIPPET_M10_MANAGER_GO")
	if goCommand == "" {
		goCommand = "go"
	}
	testName := "^TestM105BatchSummaryServerBridge$"
	if module {
		testName = "^TestM10ModuleSummaryServerBridge$"
	}
	cmd := exec.Command(goCommand, "test", "./internal/manager", "-run", testName, "-count=1", "-v")
	cmd.Dir = repositoryFile("services", "manager")
	for _, key := range []string{"PATH", "HOME", "TMPDIR", "LANG"} {
		if value := os.Getenv(key); value != "" {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off", "GOCACHE=/private/tmp/whippet-m10-go-cache", "WHIPPET_M10_BRIDGE_URL="+server.URL, "WHIPPET_M10_BRIDGE_CA="+ca, "WHIPPET_M10_BRIDGE_TOKEN="+token, "WHIPPET_M10_BRIDGE_INPUT="+input, "WHIPPET_M10_BRIDGE_RESULT="+result, "WHIPPET_M10_WORKER_ENTRY="+repositoryFile("runtimes", "worker", "dist", "author", "main.js"))
	output, err := cmd.CombinedOutput()
	if err != nil || strings.Contains(string(output), "SKIP") {
		t.Fatalf("batch bridge failed: %v\n%s", err, output)
	}
	var handoff struct {
		RunID                      string `json:"runId"`
		AttemptID                  string `json:"attemptId"`
		Result                     Result `json:"result"`
		ArtifactUploaded           bool   `json:"artifactUploaded"`
		BatchPromptChecked         bool   `json:"batchPromptChecked"`
		ModuleSummaryPromptChecked bool   `json:"moduleSummaryPromptChecked"`
	}
	raw, err := os.ReadFile(result)
	if err != nil || json.Unmarshal(raw, &handoff) != nil || handoff.RunID != a.ID || handoff.AttemptID != a.AttemptID || handoff.Result.Status != "succeeded" || !handoff.ArtifactUploaded || (!module && !handoff.BatchPromptChecked) || (module && !handoff.ModuleSummaryPromptChecked) {
		t.Fatal("invalid batch handoff", err)
	}
	if module {
		t.Log("real Node Module body/metadata/harness/evidence prompt -> Manager parser/upload -> TLS Server/PG; caller verifies summary CAS, reclaim, standalone immutable publication; synthetic model")
	} else {
		t.Log("real Node batch prompt + zero tools -> Manager parser/upload -> TLS Server/PG; caller verifies batch CAS, reclaim, atomic publish; synthetic model")
	}
	t.Log(string(output))
}
