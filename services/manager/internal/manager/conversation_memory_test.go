package manager

import (
	"strings"
	"testing"
)

func TestConversationMemoryCapabilityAndProgress(t *testing.T) {
	for _, skill := range []string{"test-author", "module-authoring", "usecase-planner", "workspace-author"} {
		a := v10Author(t)
		script := ""
		if skill == "module-authoring" || skill == "usecase-planner" {
			a = platformAuthorFixture(t, skill)
		}
		if skill == "workspace-author" {
			*a.SkillID = skill
			a.Skills = []byte(strings.Replace(string(a.Skills), "test-author", skill, 1))
			a.EditingSessionID = nil
			a.SourceVersion = []byte("null")
			a.Validation = nil
			a.ValidationEvidence = nil
			*a.AllowedTools = []string{}
		}
		a.History = &HistoryPin{MaxSequence: "20"}
		for _, tool := range []string{"read_conversation_history", "record_conversation_memory"} {
			if !hasAllowedTool(a, tool) {
				*a.AllowedTools = append(*a.AllowedTools, tool)
			}
		}
		if err := validAuthorMetadata(a, &script); err != nil {
			t.Fatal(skill, err)
		}
		a.History = nil
		if validAuthorMetadata(a, &script) == nil {
			t.Fatal("memory without pinned history", skill)
		}
	}
	for _, state := range []string{"started", "succeeded", "failed", "heartbeat"} {
		if !authorProgressPattern.MatchString("author:tool:1:record_conversation_memory:" + state) {
			t.Fatal("bounded progress rejected")
		}
	}
	if authorProgressPattern.MatchString("author:tool:1:record_conversation_memory:raw-content") {
		t.Fatal("free text progress")
	}
}
