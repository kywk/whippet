//go:build integration && m12module && m12moduleui

package server

import (
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestModuleCheckpointPostgresUI(t *testing.T) {
	f := setupModuleCheckpoint(t, "builtin")
	r := f.finish(t, f.worker(t, true), "succeeded")
	if r.Status != "succeeded" || r.AuthorPartial == nil {
		t.Fatal("fixture partial")
	}
	if err := f.p.ReleaseSlots(f.ctx, "module-checkpoint", nil); err != nil {
		t.Fatal(err)
	}
	s, err := f.p.EditingSession(f.ctx, f.item.ID, f.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	var schema string
	if err = f.p.DB.QueryRowContext(f.ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	dsn, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	q := dsn.Query()
	q.Set("search_path", schema)
	dsn.RawQuery = q.Encode()
	binary, out := os.Getenv("WHIPPET_M12_MODULE_UI_SERVER"), os.Getenv("WHIPPET_M12_MODULE_UI_OUT")
	if binary == "" || out == "" {
		t.Fatal("explicit candidate Server and evidence directory required")
	}
	command := exec.CommandContext(f.ctx, "node", repositoryFile("scripts", "test", "m12-module-checkpoint-ui.mjs"), binary, out)
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "TEST_DATABASE_URL=" + dsn.String()}
	command.Stdin = strings.NewReader(jsonText(map[string]any{"testId": f.item.ID, "sessionId": s.ID, "sourceRunId": r.ID, "revision": s.Draft.Revision, "script": s.Draft.Script, "module": s.Draft.Module, "artifactDir": f.files.root}))
	raw, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("UI flow: %v %s", err, raw)
	}
	var result struct {
		Status         string `json:"status"`
		ContinuedRunID string `json:"continuedRunId"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Status != "PASS" || !ValidID(result.ContinuedRunID) {
		t.Fatal("UI receipt")
	}
	var count int
	if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM author_continuations WHERE source_run_id=$1 AND run_id=$2`, r.ID, result.ContinuedRunID).Scan(&count); err != nil || count != 1 {
		t.Fatal("UI did not create unique child", err)
	}
	var payload []byte
	if err = f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload FROM runs WHERE id=$1`, result.ContinuedRunID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var input AuthorInput
	if json.Unmarshal(payload, &input) != nil || input.Budget.MaxModelRequests != 5 || input.Budget.MaxToolCalls != 9 {
		t.Fatal("UI reset allocation")
	}
	t.Log("real API + ConversationPanel: one explicit POST, preserved full Module, reduced child budget, no paid model")
}
