//go:build integration && m12module && m12edit && m12planui

package server

import (
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestPlanCheckpointPostgresUI(t *testing.T) {
	f, item, s, plan, request := stageCheckpointFixture(t, "builtin", 2, false)
	ms, err := f.p.EditingSession(f.ctx, stringValue(f.a.TestID), f.a.Author.EditingSessionID)
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
	binary, out := os.Getenv("WHIPPET_M12_PLAN_UI_SERVER"), os.Getenv("WHIPPET_M12_PLAN_UI_OUT")
	if binary == "" || out == "" {
		t.Fatal("explicit candidate Server and evidence output required")
	}
	command := exec.CommandContext(f.ctx, "node", repositoryFile("scripts", "test", "m12-plan-checkpoint-ui.mjs"), binary, out)
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "TEST_DATABASE_URL=" + dsn.String()}
	command.Stdin = strings.NewReader(jsonText(map[string]any{"testId": item.ID, "sessionId": s.ID, "planId": plan.ID, "stageId": "work-a", "planRevision": plan.Revision, "sourceRunId": f.a.ID, "moduleTestId": f.a.TestID, "moduleSessionId": ms.ID, "moduleRevision": request.ModuleRevision, "script": ms.Draft.Script, "module": ms.Draft.Module, "prefix": plan.Stages[0], "suffix": plan.Stages[2:], "artifactDir": f.files.root}))
	raw, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Plan UI: %v %s", err, raw)
	}
	var receipt struct {
		Status         string `json:"status"`
		ContinuedRunID string `json:"continuedRunId"`
	}
	if json.Unmarshal(raw, &receipt) != nil || receipt.Status != "PASS" || !ValidID(receipt.ContinuedRunID) {
		t.Fatal("invalid Plan UI receipt")
	}
	var inputRaw []byte
	if err = f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload FROM runs WHERE id=$1`, receipt.ContinuedRunID).Scan(&inputRaw); err != nil {
		t.Fatal(err)
	}
	var input AuthorInput
	if json.Unmarshal(inputRaw, &input) != nil || input.Budget.MaxModelRequests != 1 || input.Budget.MaxToolCalls != 3 {
		t.Fatal("UI refilled split Stage")
	}
	var count int
	if err = f.p.DB.QueryRowContext(f.ctx, `SELECT count(*) FROM plan_stage_continuations WHERE source_run_id=$1 AND run_id=$2`, f.a.ID, receipt.ContinuedRunID).Scan(&count); err != nil || count != 1 {
		t.Fatal("UI duplicate allocation", err)
	}
	t.Log("real API + PlanPanel: one explicit POST, original split reservation, one-slot child, preserved candidate/prefix/suffix")
}
