package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestModuleStagingFinalAuthority(t *testing.T) {
	base, registry := m10PlatformInput(t, "module-authoring")
	metadata := &Module{Slug: "setup", ModuleKind: "setup", ExportName: "prepare", Harness: "test('required assertion',()=>expect(true).toBe(true))"}
	base.Platform.Module = metadata
	raw, _ := json.Marshal(map[string]any{"message": "verified", "script": "export function prepare(){}", "module": metadata, "requestValidation": false})
	for _, tc := range []struct {
		name  string
		tools []string
		valid bool
	}{
		{"commit", []string{"commit_module_candidate"}, true},
		{"legacy update", []string{"update_module_candidate"}, true},
		{"stage only", []string{"stage_module_candidate_part"}, false},
		{"validation only", []string{"request_module_validation"}, false},
		{"none", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := base
			input.AllowedTools = tc.tools
			_, err := decodeModuleAuthorOutput(raw, input, registry)
			if (err == nil) != tc.valid {
				t.Fatalf("final authority: %v", err)
			}
		})
	}
	base.AllowedTools = []string{"commit_module_candidate"}
	for _, tc := range []struct {
		name   string
		change func(*AuthorInput)
		body   []byte
	}{
		{"wrong primary", func(i *AuthorInput) { i.SkillID = "test-author" }, raw},
		{"stale pin", func(i *AuthorInput) { i.ToolRegistrySHA256 = strings.Repeat("0", 64) }, raw},
		{"validation permission absent", func(*AuthorInput) {}, []byte(strings.Replace(string(raw), `"requestValidation":false`, `"requestValidation":true`, 1))},
		{"partial rejected", func(*AuthorInput) {}, []byte(strings.TrimSuffix(string(raw), "}") + `,"partial":{}}`)},
		{"full schema still required", func(*AuthorInput) {}, []byte(`{"message":"verified","script":"x","module":{"slug":"setup"},"requestValidation":false}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := base
			tc.change(&input)
			if _, err := decodeModuleAuthorOutput(tc.body, input, registry); err == nil {
				t.Fatal("invalid final accepted")
			}
		})
	}
	base.AllowedTools = append(base.AllowedTools, "request_module_validation")
	if _, err := decodeModuleAuthorOutput([]byte(strings.Replace(string(raw), `"requestValidation":false`, `"requestValidation":true`, 1)), base, registry); err != nil {
		t.Fatal(err)
	}
}

func TestModuleStagingExecutionGate(t *testing.T) {
	for _, name := range []string{"commit_module_candidate", "update_module_candidate"} {
		if !hasBrowserTools(&AuthorInput{AllowedTools: []string{name}}) {
			t.Fatal("self-test capability bypasses browser gate", name)
		}
	}
	if hasBrowserTools(&AuthorInput{AllowedTools: []string{"stage_module_candidate_part"}}) {
		t.Fatal("staging is not browser execution")
	}
	for _, name := range []string{"stage_module_candidate_part", "commit_module_candidate"} {
		if platformServerTool(name) {
			t.Fatal("local tool routed to server", name)
		}
	}
}
