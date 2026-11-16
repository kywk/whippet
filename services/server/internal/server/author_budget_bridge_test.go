//go:build integration && m12bridge

package server

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Server allocation -> actual Node Worker loop/parser -> saved artifact -> CAS
// continuation -> reduced dispatch. Models/HTTP are replaced only at fetcher.
func TestM12ContinuationPostgresRealWorkerReceiptBridge(t *testing.T) {
	for _, engine := range []string{"builtin", "vercel"} {
		t.Run(engine, func(t *testing.T) {
			m10SkillRoot(t)
			f := setupM10Partial(t)
			if engine != "builtin" {
				// A fresh independent author uses the selected runtime. Finish the
				// setup author first; never mutate an already queued snapshot.
				if err := f.p.Complete(f.ctx, "m10-partial", f.assignment.ID, f.assignment.AttemptID, Result{Status: "failed", Error: "synthetic setup"}); err != nil {
					t.Fatal(err)
				}
				if err := f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
					t.Fatal(err)
				}
				w, err := f.p.Workspace(f.ctx, f.assignment.WorkspaceID)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.p.SetAgentRuntime(f.ctx, w.ID, w.Revision, RuntimeSelection{ProfileID: engine, SkillProfiles: map[string]string{}}); err != nil {
					t.Fatal(err)
				}
				if _, err = f.p.CreateAuthor(f.ctx, f.testID, f.sessionID, "continue fixture", f.revision); err != nil {
					t.Fatal(err)
				}
				f.assignment, err = f.p.Claim(f.ctx, "m10-partial", 1)
				if err != nil || f.assignment == nil {
					t.Fatal("claim", err)
				}
			}
			input := m12ReadAuthorBudget(t, f, f.assignment.ID)
			worker := map[string]any{"kind": "author", "runId": f.assignment.ID, "attemptId": f.assignment.AttemptID, "script": f.assignment.Script, "timeoutMs": f.assignment.TimeoutMS,
				"workspaceId": f.assignment.WorkspaceID, "testId": f.assignment.TestID, "workspaceContext": f.assignment.WorkspaceContext, "scriptOrigin": f.assignment.ScriptOrigin, "author": input}
			payload, err := json.Marshal(worker)
			if err != nil {
				t.Fatal(err)
			}
			command := exec.CommandContext(f.ctx, "node", repositoryFile("scripts", "test", "m12-continuation-worker.mjs"))
			// No inherited provider key or user model configuration reaches Node.
			command.Env = []string{"PATH=" + os.Getenv("PATH"), "WHIPPET_SKILLS_PATH=" + repositoryFile("runtimes", "worker", "skills")}
			command.Stdin = bytes.NewReader(payload)
			var diagnostic bytes.Buffer
			command.Stderr = &diagnostic
			raw, err := command.Output()
			if err != nil {
				t.Fatalf("synthetic Worker bridge: %v; %s", err, diagnostic.String())
			}
			out, err := decodeAuthorOutput(raw)
			if err != nil || out.Partial == nil || out.Partial.Usage == nil || out.Partial.Usage.ModelRequests != 3 {
				t.Fatal("guarded receipt", err)
			}
			artifact, err := f.files.Save(f.assignment.ID, f.assignment.AttemptID, "author.json", strings.NewReader(string(raw)))
			if err != nil {
				t.Fatal(err)
			}
			if err = f.p.SaveArtifact(f.ctx, artifact); err != nil {
				t.Fatal(err)
			}
			if err = f.p.Complete(f.ctx, "m10-partial", f.assignment.ID, f.assignment.AttemptID, Result{Status: "succeeded"}); err != nil {
				t.Fatal(err)
			}
			f = m12ContinueAndClaim(t, f)
			if f.assignment.Author.Budget.MaxModelRequests != input.Budget.MaxModelRequests-3 || f.assignment.Author.Budget.MaxToolCalls != 0 || f.assignment.Author.Runtime.Engine != engine {
				t.Fatal("bridge reset quota/runtime")
			}
		})
	}
}
