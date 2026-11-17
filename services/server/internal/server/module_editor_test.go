package server

import (
	"errors"
	"slices"
	"testing"
)

func TestModuleEditorSnapshotAndRemainingBudget(t *testing.T) {
	m10SkillRoot(t)
	input, registry := m10PlatformInput(t, "module-authoring")
	input.Platform.Module = &Module{Slug: "payment", ModuleKind: "step", ExportName: "run"}
	input.AllowedTools = []string{"stage_module_candidate_part", "commit_module_candidate", "read_module_candidate_part", "edit_module_candidate"}
	if err := snapshotAuthor(&input); err != nil {
		t.Fatal(err)
	}
	if !hasBrowserTools(&AuthorInput{AllowedTools: []string{"edit_module_candidate"}}) {
		t.Fatal("local self-test bypassed scope gate")
	}
	for _, name := range []string{"read_module_candidate_part", "edit_module_candidate"} {
		if !slices.Contains(input.AllowedTools, name) {
			t.Fatal("missing editor capability")
		}
		if platformServerTool(name) || slices.Contains(externalTools(input), name) {
			t.Fatal("local editor exposed to MCP/server")
		}
		tool, ok := registry.tool(name)
		if !ok || tool.Side != "worker" {
			t.Fatal("not registered locally")
		}
	}
	chain := authorChainBudget{RootRunID: NewID(), Ordinal: 2, MaxRuns: 3, Limit: *input.Budget, Spent: AuthorUsage{7, 11, 1}}
	legacy := input
	legacy.AllowedTools = []string{"stage_module_candidate_part", "commit_module_candidate"}
	if err := chain.constrain(&legacy); !errors.Is(err, ErrContinuationBudget) {
		t.Fatal("legacy staging cannot finish in one slot", err)
	}
	if err := chain.constrain(&input); err != nil || input.Budget.MaxModelRequests != 1 || input.Budget.MaxToolCalls != 1 || effectiveOutputTokens(input.Budget) != 16384 {
		t.Fatal("editor did not preserve one-slot allocation", err)
	}
}
