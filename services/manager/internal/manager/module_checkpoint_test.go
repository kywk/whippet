package manager

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestModuleCheckpointArtifactGuards(t *testing.T) {
	a := platformAuthorFixture(t, "module-authoring")
	*a.AllowedTools = append(*a.AllowedTools, "commit_module_candidate")
	script := "export function run(){return 1}"
	module := json.RawMessage(`{"slug":"checkpoint","moduleKind":"step","exportName":"run","signature":"run()","inputs":"none","returns":"one","preconditions":"限制：<>&\u2028不得刪除斷言","postconditions":"保留原斷言","harness":"import {test,expect} from '@playwright/test';test('intent',()=>{expect(1).toBe(1)});"}`)
	a.Platform, _ = json.Marshal(map[string]any{"planId": nil, "stageId": nil, "module": module})
	partial := map[string]any{"reason": "checkpoint_saved", "nextStep": "剩餘斷言", "checkpoint": map[string]any{"scriptHash": fmt.Sprintf("%x", sha256.Sum256([]byte(script))), "moduleHash": moduleCheckpointHash(module), "selfTestPassed": true}, "usage": map[string]int{"modelRequests": 3, "toolCalls": 3, "durationMs": 1}}
	raw, _ := json.Marshal(map[string]any{"message": "unfinished", "script": script, "module": module, "requestValidation": false, "partial": partial})
	if !validPlatformArtifact(raw, a) {
		t.Fatal("valid Module partial rejected")
	}
	paired := *a
	paired.Platform, _ = json.Marshal(map[string]any{"planId": "11111111-1111-4111-8111-111111111111", "stageId": "s", "module": module})
	if !validPlatformArtifact(raw, &paired) {
		t.Fatal("bound Stage checkpoint rejected")
	}

	for _, name := range []string{"hash", "harness", "slug", "no-usage", "over-budget", "validation", "duplicate", "null", "incomplete-plan", "old-pin"} {
		t.Run(name, func(t *testing.T) {
			var fields map[string]any
			if json.Unmarshal(raw, &fields) != nil {
				t.Fatal("fixture")
			}
			v := *a
			p := fields["partial"].(map[string]any)
			switch name {
			case "hash":
				p["checkpoint"].(map[string]any)["moduleHash"] = strings.Repeat("0", 64)
			case "harness":
				fields["module"].(map[string]any)["harness"] = "changed"
			case "slug":
				fields["module"].(map[string]any)["slug"] = "another-module"
				changed, _ := json.Marshal(fields["module"])
				p["checkpoint"].(map[string]any)["moduleHash"] = moduleCheckpointHash(changed)
			case "no-usage":
				delete(p, "usage")
			case "over-budget":
				p["usage"].(map[string]any)["modelRequests"] = 9
			case "validation":
				fields["requestValidation"] = true
			case "null":
				fields["partial"] = nil
			case "incomplete-plan":
				v.Platform, _ = json.Marshal(map[string]any{"planId": "11111111-1111-4111-8111-111111111111", "stageId": nil, "module": module})
			case "old-pin":
				old := "13.0"
				v.ToolRegistryVersion = &old
			}
			data, _ := json.Marshal(fields)
			if name == "duplicate" {
				data = []byte(strings.Replace(string(data), `"reason":"checkpoint_saved"`, `"reason":"budget_exhausted","reason":"checkpoint_saved"`, 1))
			}
			if validPlatformArtifact(data, &v) {
				t.Fatal("invalid Module partial accepted")
			}
		})
	}
}
