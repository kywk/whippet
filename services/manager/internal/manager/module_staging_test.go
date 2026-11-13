package manager

import (
	"encoding/json"
	"testing"
)

func TestModuleStagingLocalToolsAndFinalAuthority(t *testing.T) {
	a := platformAuthorFixture(t, "module-authoring")
	planner := platformAuthorFixture(t, "usecase-planner")
	ordinary := v10Author(t)
	for _, name := range []string{"stage_module_candidate_part", "commit_module_candidate"} {
		if !platformTool(name) || platformServerTool(name) || !allowedPlatformTool(a, name) || allowedPlatformTool(planner, name) || allowedPlatformTool(ordinary, name) {
			t.Fatal("tool routing or role boundary failed")
		}
		if !authorProgressPattern.MatchString("author:tool:1:"+name+":succeeded") || authorProgressPattern.MatchString("author:tool:1:"+name+":succeeded SECRET_SENTINEL") {
			t.Fatal("progress grammar failed")
		}
	}
	raw, _ := json.Marshal(map[string]any{"message": "synthetic", "script": "export function search(){return 1}", "module": moduleFixture(), "requestValidation": false})
	for _, name := range []string{"update_module_candidate", "commit_module_candidate", "stage_module_candidate_part"} {
		tools := []string{name}
		a.AllowedTools = &tools
		if validPlatformArtifact(raw, a) != (name != "stage_module_candidate_part") {
			t.Fatal("final authority changed")
		}
	}
}

func TestModuleStagingRegistryBounds(t *testing.T) {
	r, e := loadToolRegistry()
	if e != nil {
		t.Fatal(e)
	}
	for _, tool := range r.Tools {
		if tool.Name != "stage_module_candidate_part" && tool.Name != "commit_module_candidate" {
			continue
		}
		var good any
		if tool.Name == "stage_module_candidate_part" {
			good = map[string]any{"part": "script", "content": "synthetic", "stagingRevision": 0}
		} else {
			m := moduleFixture()
			delete(m, "harness")
			good = map[string]any{"stagingRevision": 2, "metadata": m}
		}
		raw, _ := json.Marshal(good)
		if !validToolArguments(tool, raw) {
			t.Fatal("valid staged tool rejected")
		}
		bad := good.(map[string]any)
		bad["unknown"] = "SECRET_SENTINEL"
		raw, _ = json.Marshal(bad)
		if validToolArguments(tool, raw) {
			t.Fatal("unknown field accepted")
		}
	}
}
