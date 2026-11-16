package server

import "testing"

func TestConversationMemorySnapshotGate(t *testing.T) {
	m10SkillRoot(t)
	for _, skill := range []string{"test-author", "module-authoring", "workspace-author", "usecase-planner"} {
		input := AuthorInput{SkillID: skill, History: &AuthorHistory{MaxSequence: "20"}, AllowedTools: []string{"read_conversation_history"}}
		if err := snapshotAuthor(&input); err != nil {
			t.Fatal(skill, err)
		}
		has := false
		for _, tool := range input.AllowedTools {
			has = has || tool == "record_conversation_memory"
		}
		if !has {
			t.Fatal("missing grounded memory capability", skill)
		}
		for _, tool := range externalTools(input) {
			if tool == "record_conversation_memory" {
				t.Fatal("worker-local memory offered over MCP")
			}
		}
	}
	for _, history := range []*AuthorHistory{nil, {MaxSequence: "20"}} {
		input := AuthorInput{SkillID: "test-author", History: history, AllowedTools: []string{"record_conversation_memory"}}
		if err := snapshotAuthor(&input); err != nil {
			t.Fatal(err)
		}
		for _, tool := range input.AllowedTools {
			if tool == "record_conversation_memory" {
				t.Fatal("memory without history capability")
			}
		}
	}
}
