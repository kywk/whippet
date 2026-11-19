//go:build integration && m12reference

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestM12ReferenceWorkerMCPClaimToolSubmitAndRecovery(t *testing.T) {
	for _, engine := range []string{"vercel", "pi"} {
		t.Run(engine, func(t *testing.T) { runM12ReferenceWorkerFlow(t, false, engine) })
	}
}

func TestM12FrozenSnapshotMCPAndSubmitRecovery(t *testing.T) {
	for _, engine := range []string{"vercel", "pi"} {
		t.Run(engine, func(t *testing.T) { runM12ReferenceWorkerFlow(t, true, engine) })
	}
}

func runM12ReferenceWorkerFlow(t *testing.T, frozen bool, engine string) {
	// MCP publishes all packaged resources. The older M10 fixture deliberately
	// omits catalog-reuse and therefore correctly disables the entire MCP gate.
	t.Setenv("WHIPPET_SKILLS_PATH", repositoryFile("runtimes", "worker", "skills"))
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	w, err := p.CreateWorkspace(ctx, "M12 reference worker")
	if err != nil {
		t.Fatal(err)
	}
	w, err = p.SetAuthorEngine(ctx, w.ID, w.Revision, "external")
	if err != nil {
		t.Fatal(err)
	}
	item, err := p.CreateTest(ctx, w.ID, "reference candidate", "")
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	original := "import {test} from '@playwright/test';test('original',()=>{});\n//" + strings.Repeat("snapshot-original ", 1400)
	if frozen {
		var saved Draft
		saved, err = p.SaveDraft(ctx, item.ID, session.ID, session.Draft.Revision, original)
		if err != nil {
			t.Fatal(err)
		}
		session.Draft = &saved
	}
	sub, err := p.CreateAuthor(ctx, item.ID, session.ID, "使用 page.setContent 建立 Reference ready 標題，保留候選稿供人工檢視，不要求正式驗證。", session.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err := p.CreateAgentToken(ctx, w.ID, "reference fixture")
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := NewAPI(p, files, nil, "synthetic-reference-manager", logger).WithAdminAccess("synthetic-reference-admin", "")
	http := httptest.NewServer(api.Handler(nil))
	defer http.Close()
	directory := t.TempDir()
	if err = os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	tokenPath, statePath := filepath.Join(directory, "agent"), filepath.Join(directory, "journal.json")
	if err = os.WriteFile(tokenPath, []byte(secret), 0600); err != nil {
		t.Fatal(err)
	}
	fixture := map[string]string{"url": http.URL + "/mcp", "tokenFile": tokenPath, "stateFile": statePath, "engine": engine}
	if frozen {
		fixture["frozen"] = "true"
		fixture["expectedSnapshotHash"] = scriptHash(original)
		fixture["expectedSnapshotPrefix"] = original[:8192]
	}
	input, _ := json.Marshal(fixture)
	command := exec.CommandContext(ctx, "node", repositoryFile("scripts", "test", "m12-reference-worker.mjs"))
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "WHIPPET_SKILLS_PATH=" + repositoryFile("runtimes", "worker", "skills")}
	command.Stdin = bytes.NewReader(input)
	var diagnostic bytes.Buffer
	command.Stderr = &diagnostic
	raw, err := command.Output()
	if err != nil {
		t.Fatalf("reference worker fixture failed: %v; safe result=%s", err, raw)
	}
	var report struct {
		Passed bool `json:"passed"`
		Result struct {
			State           string  `json:"state"`
			RunID           string  `json:"runId"`
			AppliedRevision int     `json:"appliedRevision"`
			ValidationRunID *string `json:"validationRunId"`
		} `json:"result"`
		Models         int `json:"models"`
		Claims         int `json:"claims"`
		Tools          int `json:"tools"`
		SubmitAttempts int `json:"submitAttempts"`
		PaidCalls      int `json:"paidProviderCalls"`
	}
	if json.Unmarshal(raw, &report) != nil || !report.Passed || report.Result.State != "submitted" || report.Result.RunID != sub.Run.ID || report.Result.AppliedRevision != session.Draft.Revision+1 || report.Result.ValidationRunID != nil || report.Models != 2 || report.Claims != 1 || report.Tools != 1 || report.SubmitAttempts != 2 || report.PaidCalls != 0 {
		t.Fatal("reference MCP flow result did not match")
	}
	draft, err := p.Draft(ctx, item.ID)
	if err != nil || draft.Revision != session.Draft.Revision+1 || draft.ScriptOrigin != "ai" || !strings.Contains(draft.Script, "Reference ready") || draft.ValidationRunID != nil {
		t.Fatal("candidate draft not persisted correctly", err)
	}
	run, err := p.Run(ctx, sub.Run.ID)
	if err != nil || run.Status != "succeeded" || run.AuthorEngine != "external" {
		t.Fatal("external Run not completed", err)
	}
	var count, active int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1`, item.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("unexpected second Run", err)
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM external_author_claims WHERE run_id=$1 AND state='active'`, sub.Run.ID).Scan(&active); err != nil || active != 0 {
		t.Fatal("claim remains active", err)
	}
	journal, err := os.ReadFile(statePath)
	if err != nil || bytes.Contains(journal, []byte(secret)) {
		t.Fatal("journal exposed Agent Token")
	}
	if frozen {
		t.Logf("real HTTP MCP -> %s reference client -> frozen snapshot reference -> pinned 8KiB page -> synthetic model x2 -> submit x2 same ID/body -> AI draft revision +1; paid provider calls=0", engine)
	} else {
		t.Logf("real HTTP MCP -> %s reference client -> synthetic model x2 -> read_draft x1 -> submit x2 same ID/body -> AI draft revision +1; paid provider calls=0", engine)
	}
}
