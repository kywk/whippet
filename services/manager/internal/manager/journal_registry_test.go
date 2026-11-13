package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func terminalRegistryFixture(t *testing.T, skill string) (Config, record, string) {
	t.Helper()
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	current := filepath.Join(dir, "current.json")
	raw, _ := json.Marshal(registry)
	if os.WriteFile(current, raw, 0600) != nil {
		t.Fatal("registry fixture write")
	}
	registry.Version = "10.2"
	var oldTools []registryTool
	for _, tool := range registry.Tools {
		if tool.Name != "stage_module_candidate_part" && tool.Name != "commit_module_candidate" {
			oldTools = append(oldTools, tool)
		}
	}
	registry.Tools = oldTools
	old := filepath.Join(dir, "old.json")
	raw, _ = json.Marshal(registry)
	if os.WriteFile(old, raw, 0600) != nil {
		t.Fatal("old fixture write")
	}
	t.Setenv("WHIPPET_TOOL_REGISTRY_PATH", old)
	a := v10Author(t)
	if skill != "test-author" {
		a = platformAuthorFixture(t, skill)
	}
	r := record{RunID: newID(), AttemptID: newID(), ResultMessageID: newID(), Phase: "complete", Reclaimed: true, Kind: "author", TimeoutMS: 180000, Author: a, Result: &Result{Status: "timed_out"}}
	cfg := Config{ServerURL: "http://synthetic.invalid", Token: "synthetic", ManagerID: "synthetic-manager", WorkerImage: "synthetic-image", WorkDir: filepath.Join(dir, "work"), MaxWorkers: 1}
	baseline, err := New(cfg)
	if err != nil {
		t.Fatal("empty startup failed")
	}
	baseline.Close()
	path := filepath.Join(cfg.WorkDir, "journal", r.AttemptID+".json")
	if atomicJSON(path, r) != nil {
		t.Fatal("fixture write")
	}
	baseline, err = New(cfg)
	if err != nil {
		t.Fatalf("old registry baseline: %v", err)
	}
	baseline.Close()
	t.Setenv("WHIPPET_TOOL_REGISTRY_PATH", current)
	return cfg, r, path
}

func TestTerminalJournalRegistryUpgradePreservesBytesAndSkipsExecution(t *testing.T) {
	for _, skill := range []string{"test-author", "module-authoring", "usecase-planner"} {
		t.Run(skill, func(t *testing.T) {
			cfg, r, path := terminalRegistryFixture(t, skill)
			before, _ := os.ReadFile(path)
			m, err := New(cfg)
			if err != nil {
				t.Fatalf("terminal history blocks startup: %v", err)
			}
			defer m.Close()
			if validAuthorMetadata(r.Author, nil) == nil {
				t.Fatal("historical pin became executable")
			}
			d := newLifecycleDocker()
			m.docker = d
			m.recoverAttempts(context.Background())
			m.wg.Wait()
			if len(d.started) != 0 || len(d.removing) != 0 || len(m.records) != 1 || activeCount(t, m) != 0 {
				t.Fatal("complete record recovered as live work")
			}
			// A fresh current-pin dispatch with the same identity is still deduplicated.
			a := v10Author(t)
			dispatch := authorDispatch()
			dispatch.Author = a
			if validDispatch(dispatch) != nil {
				t.Fatal("current dispatch fixture invalid")
			}
			err = m.accept(context.Background(), message(cfg.ManagerID, "dispatch", r.RunID, r.AttemptID, dispatch))
			if err == nil {
				t.Fatal("offline ACK should fail before any execution")
			}
			// Historical dispatch remains fail-closed; never repin or execute it.
			dispatch.Author = r.Author
			if m.accept(context.Background(), message(cfg.ManagerID, "dispatch", r.RunID, r.AttemptID, dispatch)) == nil {
				t.Fatal("old dispatch authorized")
			}
			if len(d.started) != 0 || len(m.records) != 1 || m.records[r.AttemptID].ResultMessageID != r.ResultMessageID {
				t.Fatal("duplicate resurrected terminal attempt")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("historical bytes changed")
			}
		})
	}
}

func TestTerminalJournalRegistryUpgradeRejectsActiveAndMalformed(t *testing.T) {
	cases := map[string]func(*record){
		"accepted": func(r *record) { r.Phase = "accepted" }, "running": func(r *record) { r.Phase = "running" }, "collecting-reclaimed": func(r *record) { r.Phase = "collecting" }, "complete-unreclaimed": func(r *record) { r.Reclaimed = false },
		"missing-result": func(r *record) { r.Result = nil }, "bad-result": func(r *record) { r.Result.Status = "running" }, "bad-artifact": func(r *record) { r.Artifacts = []string{"../invalid"} }, "bad-workspace": func(r *record) { r.WorkspaceID = "invalid" },
		"bad-hash": func(r *record) { v := "bad"; r.Author.ToolRegistrySHA256 = &v }, "empty-version": func(r *record) { v := ""; r.Author.ToolRegistryVersion = &v }, "partial-capability": func(r *record) { r.Author.Model = nil }, "null-budget": func(r *record) { r.Author.Budget = json.RawMessage("null") },
		"invalid-budget": func(r *record) {
			r.Author.Budget = json.RawMessage(`{"maxModelRequests":8,"maxToolCalls":12,"maxDurationMs":0}`)
		}, "invalid-pin": func(r *record) { r.Author.Skills = json.RawMessage(`[]`) },
		"unknown-tool": func(r *record) { *r.Author.AllowedTools = append(*r.Author.AllowedTools, "unimplemented") }, "wrong-role-tool": func(r *record) { *r.Author.AllowedTools = append(*r.Author.AllowedTools, "commit_module_candidate") },
		"invalid-context": func(r *record) { *r.Author.ContextRevision = -1 }, "invalid-source": func(r *record) { r.Author.SourceVersion = json.RawMessage(`{"id":"bad"}`) }, "bad-kind": func(r *record) { r.Kind = "run" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cfg, r, path := terminalRegistryFixture(t, "test-author")
			mutate(&r)
			if atomicJSON(path, r) != nil {
				t.Fatal("fixture write")
			}
			before, _ := os.ReadFile(path)
			m, err := New(cfg)
			if err == nil {
				m.Close()
				t.Fatal("unsafe journal accepted")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("rejected bytes changed")
			}
		})
	}
	t.Run("invalid-module-schema", func(t *testing.T) {
		cfg, r, path := terminalRegistryFixture(t, "module-authoring")
		r.Author.Platform = json.RawMessage(strings.Replace(string(r.Author.Platform), `"exportName":"search"`, `"exportName":"return"`, 1))
		if atomicJSON(path, r) != nil {
			t.Fatal("fixture write")
		}
		m, err := New(cfg)
		if err == nil {
			m.Close()
			t.Fatal("invalid module accepted")
		}
	})
}
