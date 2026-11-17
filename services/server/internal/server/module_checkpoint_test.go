package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func moduleCheckpointOutput(t *testing.T) (AuthorInput, *ToolRegistry, moduleAuthorOutput) {
	t.Helper()
	input, registry := m10PlatformInput(t, "module-authoring")
	input.AllowedTools = []string{"commit_module_candidate", "request_module_validation"}
	m := &Module{Slug: "checkpoint", ModuleKind: "step", ExportName: "run", Signature: "run()", Inputs: "none", Returns: "one", Preconditions: "限制：<>&\u2028不得刪除斷言", Postconditions: "保留原斷言", Harness: m10BundleSpec}
	input.Platform.Module = m
	script := "export function run(){return 1}"
	digest := moduleCheckpointHash(m)
	return input, registry, moduleAuthorOutput{Message: stringPointer("unfinished"), Script: &script, Module: m, RequestValidation: new(bool), Partial: &AuthorPartialOutput{Reason: "checkpoint_saved", NextStep: "完成剩餘斷言", Checkpoint: &AuthorCheckpoint{ScriptHash: scriptHash(script), ModuleHash: &digest, SelfTestPassed: true}, Usage: &AuthorUsage{3, 3, 1}}}
}

func TestModuleCheckpointArtifactGuards(t *testing.T) {
	input, registry, good := moduleCheckpointOutput(t)
	raw := []byte(jsonText(good))
	if _, err := decodeModuleAuthorOutput(raw, input, registry); err != nil {
		t.Fatal(err)
	}
	paired := input
	platform := *input.Platform
	planID := NewID()
	stageID := "s"
	platform.PlanID = &planID
	platform.StageID = &stageID
	paired.Platform = &platform
	if _, err := decodeModuleAuthorOutput(raw, paired, registry); err != nil {
		t.Fatal("bound Stage checkpoint rejected", err)
	}

	for _, name := range []string{"hash", "harness", "metadata", "no-checkpoint", "no-usage", "over-budget", "validation", "unknown", "duplicate", "null", "incomplete-plan", "old-pin"} {
		t.Run(name, func(t *testing.T) {
			var out moduleAuthorOutput
			if json.Unmarshal(raw, &out) != nil {
				t.Fatal("fixture")
			}
			v := input
			switch name {
			case "hash":
				out.Partial.Checkpoint.ScriptHash = strings.Repeat("0", 64)
			case "harness":
				out.Module.Harness += "// changed"
			case "metadata":
				out.Module.Preconditions = "已允許刪除斷言"
			case "no-checkpoint":
				out.Partial.Checkpoint = nil
			case "no-usage":
				out.Partial.Usage = nil
			case "over-budget":
				out.Partial.Usage.ModelRequests = 9
			case "validation":
				*out.RequestValidation = true
			case "incomplete-plan":
				p := *input.Platform
				id := NewID()
				stage := "s"
				p.PlanID = &id
				p.StageID = nil
				_ = stage
				v.Platform = &p
			case "old-pin":
				v.ToolRegistryVersion = "13.0"
			}
			data := jsonText(out)
			switch name {
			case "unknown":
				data = strings.Replace(data, `"checkpoint":{`, `"checkpoint":{"validated":true,`, 1)
			case "duplicate":
				data = strings.Replace(data, `"reason":"checkpoint_saved"`, `"reason":"budget_exhausted","reason":"checkpoint_saved"`, 1)
			case "null":
				data = strings.Replace(data, `"partial":{`, `"partial":null,"partial":{`, 1)
			}
			if _, err := decodeModuleAuthorOutput([]byte(data), v, registry); err == nil {
				t.Fatal("invalid checkpoint accepted")
			}
		})
	}
	// The new fields/reason never widen the ordinary Test parser.
	if _, err := decodeAuthorOutput([]byte(`{"message":"m","requestValidation":false,"partial":{"reason":"budget_exhausted","nextStep":"remaining","checkpoint":null}}`)); err == nil {
		t.Fatal("explicit null checkpoint accepted as omitted")
	}
	for _, reason := range []string{"checkpoint_saved", "budget_exhausted"} {
		out := authorOutput{Message: good.Message, Script: good.Script, RequestValidation: new(bool), Partial: good.Partial}
		out.Partial.Reason = reason
		if _, err := decodeAuthorOutput([]byte(jsonText(out))); err == nil {
			t.Fatal("Module checkpoint accepted as Test")
		}
	}
}
