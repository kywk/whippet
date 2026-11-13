package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setOutputBudget(t *testing.T, root, skill string, value any) {
	t.Helper()
	path := filepath.Join(root, skill, "manifest.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	budget := m["budget"].(map[string]any)
	if value == nil {
		delete(budget, "maxOutputTokens")
	} else {
		budget["maxOutputTokens"] = value
	}
	raw, err = json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestM109OutputBudgetStrictJSON(t *testing.T) {
	base := `{"maxModelRequests":8,"maxToolCalls":12,"maxDurationMs":180000`
	for _, extra := range []string{"", `,"maxOutputTokens":1`, `,"maxOutputTokens":8192`, `,"maxOutputTokens":16384`} {
		raw := base + extra + "}"
		var budget AuthorBudget
		if err := json.Unmarshal([]byte(raw), &budget); err != nil {
			t.Fatal(raw, err)
		}
		encoded, _ := json.Marshal(budget)
		if extra == "" && (budget.effectiveMaxOutputTokens() != 8192 || strings.Contains(string(encoded), "maxOutputTokens")) {
			t.Fatal("legacy rewritten")
		}
	}
	for _, extra := range []string{`,"maxOutputTokens":null`, `,"maxOutputTokens":true`, `,"maxOutputTokens":"8192"`, `,"maxOutputTokens":1.5`, `,"maxOutputTokens":0`, `,"maxOutputTokens":-1`, `,"maxOutputTokens":16385`, `,"maxOutputTokens":9007199254740992`, `,"unknown":1`, `,"maxOutputTokens":8192,"maxOutputTokens":8192`, `,"maxToolCalls":12`} {
		var budget AuthorBudget
		if json.Unmarshal([]byte(base+extra+"}"), &budget) == nil {
			t.Fatal("accepted", extra)
		}
	}
	for _, raw := range []string{`null`, `[]`, `{}`, `{"maxModelRequests":8,"maxToolCalls":null,"maxDurationMs":180000}`, base + "} {}"} {
		var budget AuthorBudget
		if json.Unmarshal([]byte(raw), &budget) == nil {
			t.Fatal("accepted", raw)
		}
	}
}

func TestM109OutputBudgetSnapshotPolicy(t *testing.T) {
	root := m10SkillRoot(t)
	setOutputBudget(t, root, "module-authoring", nil)
	old := AuthorInput{SkillID: "module-authoring"}
	if err := snapshotAuthor(&old); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(old)
	setOutputBudget(t, root, "module-authoring", 16384)
	next := AuthorInput{SkillID: "module-authoring"}
	if err := snapshotAuthor(&next); err != nil {
		t.Fatal(err)
	}
	if next.Budget.effectiveMaxOutputTokens() != 16384 || next.SkillVersion != "1" || next.Skills[0].ManifestSHA256 == old.Skills[0].ManifestSHA256 || next.Budget.MaxModelRequests != 8 || next.Budget.MaxToolCalls != 12 || next.Budget.MaxDurationMS != 180000 {
		t.Fatal("wrong snapshot")
	}
	after, _ := json.Marshal(old)
	if string(before) != string(after) || old.Budget.MaxOutputTokens != nil {
		t.Fatal("old snapshot changed")
	}
	for _, id := range []string{"test-author", "workspace-author", "usecase-planner", "acceptance-summary", "playwright-authoring"} {
		setOutputBudget(t, root, id, 16384)
		skill := id
		if id == "playwright-authoring" {
			skill = "test-author"
		}
		input := AuthorInput{SkillID: skill}
		if snapshotAuthor(&input) == nil {
			t.Fatal("non-primary module cap accepted", id)
		}
		setOutputBudget(t, root, id, nil)
		if err := snapshotAuthor(&input); err != nil || input.Budget.effectiveMaxOutputTokens() != 8192 {
			t.Fatal("legacy policy", id, err)
		}
	}
	setOutputBudget(t, root, "module-authoring", 1024)
	lower := AuthorInput{SkillID: "module-authoring"}
	if err := snapshotAuthor(&lower); err != nil || lower.Budget.effectiveMaxOutputTokens() != 1024 {
		t.Fatal("lower cap", err)
	}
}

func TestM109OutputBudgetAssignment(t *testing.T) {
	root := m10SkillRoot(t)
	for _, value := range []any{nil, 16384} {
		setOutputBudget(t, root, "module-authoring", value)
		input := AuthorInput{SkillID: "module-authoring", ConversationID: NewID(), BaseRevision: 1, AllowedTools: []string{"read_module_draft"}}
		if err := snapshotAuthor(&input); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(input)
		a := Assignment{Run: Run{Kind: "author"}}
		if err := decodeAssignmentAuthor(&a, string(raw)); err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(a.Author)
		if string(raw) != string(encoded) {
			t.Fatal("dispatch changed snapshot")
		}
		registry, err := loadToolRegistry()
		if err != nil {
			t.Fatal(err)
		}
		if err := validateToolSnapshot(*a.Author, registry, "read_module_draft"); err != nil {
			t.Fatal(err)
		}
		if value != nil {
			input.SkillID = "test-author"
			raw, _ = json.Marshal(input)
			if decodeAssignmentAuthor(&a, string(raw)) == nil {
				t.Fatal("non-module dispatch accepted")
			}
			if validateToolSnapshot(input, registry, "read_module_draft") == nil {
				t.Fatal("non-module tool accepted")
			}
			input.SkillID = "module-authoring"
			input.Skills = nil
			raw, _ = json.Marshal(input)
			if decodeAssignmentAuthor(&a, string(raw)) == nil {
				t.Fatal("unbound high cap")
			}
		}
	}
}
