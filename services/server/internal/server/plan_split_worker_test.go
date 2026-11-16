//go:build integration && m12split

package server

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

func TestStageSplitRealWorkerBudget(t *testing.T) {
	for _, engine := range []string{"builtin", "vercel"} {
		t.Run(engine, func(t *testing.T) {
			p, ctx, item, _, plan, request := splitFixture(t)
			if _, err := p.SetAgentRuntime(ctx, item.WorkspaceID, 1, RuntimeSelection{ProfileID: engine, SkillProfiles: map[string]string{}}); err != nil {
				t.Fatal(err)
			}
			plan, err := p.SplitPlanStage(ctx, plan.ID, "work", request)
			if err != nil {
				t.Fatal(err)
			}
			plan, err = p.ConfirmPlanThrough(ctx, plan.ID, plan.Revision, "work-a")
			if err != nil {
				t.Fatal(err)
			}
			if err = p.RegisterManager(ctx, "split-worker", 1); err != nil {
				t.Fatal(err)
			}
			a, err := p.Claim(ctx, "split-worker", 1)
			if err != nil || a == nil || a.Author == nil || a.Author.Runtime.Engine != engine {
				t.Fatal("worker assignment", err)
			}
			input := map[string]any{"kind": "author", "runId": a.ID, "attemptId": a.AttemptID, "script": a.Script, "timeoutMs": a.TimeoutMS, "author": a.Author, "workspaceId": a.WorkspaceID, "testId": a.TestID, "workspaceContext": a.WorkspaceContext, "workspaceSettings": a.WorkspaceSettings, "scriptOrigin": a.ScriptOrigin}
			cmd := exec.Command("node", repositoryFile("scripts", "test", "m12-stage-split-worker.mjs"))
			cmd.Stdin = strings.NewReader(jsonText(input))
			raw, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("synthetic Worker: %s", raw)
			}
			var output map[string]any
			if json.Unmarshal(raw, &output) != nil || output["requestValidation"] != true {
				t.Fatal("guarded output")
			}
		})
	}
}
