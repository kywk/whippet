package manager

import "testing"

func TestM12AuthorSnapshotCapabilityAndProgress(t *testing.T) {
	for _, skill := range []string{"test-author", "module-authoring"} {
		a := v10Author(t)
		script := "original"
		if skill == "module-authoring" {
			a = platformAuthorFixture(t, skill)
			script = "export function search(){return 1}"
		}
		*a.AllowedTools = append(*a.AllowedTools, "read_author_snapshot")
		if err := validAuthorMetadata(a, &script); err != nil {
			t.Fatal(skill, err)
		}
	}
	planner := platformAuthorFixture(t, "usecase-planner")
	*planner.AllowedTools = append(*planner.AllowedTools, "read_author_snapshot")
	script := ""
	if validAuthorMetadata(planner, &script) == nil {
		t.Fatal("planner received snapshot capability")
	}
	legacy := m7Dispatch(t, false).Author
	*legacy.AllowedTools = append(*legacy.AllowedTools, "read_author_snapshot")
	if validAuthorMetadata(legacy, &script) == nil {
		t.Fatal("legacy received new capability")
	}
	for _, status := range []string{"started", "succeeded", "failed", "heartbeat"} {
		if !authorProgressPattern.MatchString("author:tool:1:read_author_snapshot:" + status) {
			t.Fatal("safe progress rejected")
		}
	}
	if authorProgressPattern.MatchString("author:tool:1:read_author_snapshot:arbitrary") {
		t.Fatal("free text progress accepted")
	}
}
