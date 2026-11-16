package server

import (
	"fmt"
	"strings"
)

func standaloneModule(input AuthorInput) bool {
	return input.SkillID == "module-authoring" && input.Platform != nil && input.Platform.Module != nil && input.Platform.PlanID == nil && input.Platform.StageID == nil
}

// Same ordered length-prefixed UTF-8 fields as the Worker and Manager. Includes
// the complete harness; JSON escaping and object property order are irrelevant.
func moduleCheckpointHash(m *Module) string {
	var text strings.Builder
	for _, value := range []string{m.Slug, m.ModuleKind, m.ExportName, m.Signature, m.Inputs, m.Returns, m.Preconditions, m.Postconditions, m.Harness} {
		fmt.Fprintf(&text, "%d:%s", len(value), value)
	}
	return scriptHash(text.String())
}

func validateModulePartial(out moduleAuthorOutput, input AuthorInput, registry *ToolRegistry) error {
	if out.Partial == nil {
		return nil
	}
	p := out.Partial
	if !standaloneModule(input) || validateToolSnapshot(input, registry, "commit_module_candidate") != nil ||
		p.Reason != "checkpoint_saved" || !validOutputText(p.NextStep, 8192) ||
		out.RequestValidation == nil || *out.RequestValidation || out.Script == nil || out.Module == nil ||
		p.Checkpoint == nil || !p.Checkpoint.SelfTestPassed || !sha256Hex(p.Checkpoint.ScriptHash) || p.Checkpoint.ScriptHash != scriptHash(*out.Script) ||
		p.Checkpoint.ModuleHash == nil || !sha256Hex(*p.Checkpoint.ModuleHash) || *p.Checkpoint.ModuleHash != moduleCheckpointHash(out.Module) || !validAuthorUsage(p.Usage, input.Budget) {
		return ErrInvalid
	}
	return nil
}
