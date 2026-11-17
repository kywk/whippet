package manager

import "testing"

func TestModuleEditorCapabilitiesAndProgress(t *testing.T) {
	a := platformAuthorFixture(t, "module-authoring")
	*a.AllowedTools = append(*a.AllowedTools, "commit_module_candidate", "read_module_candidate_part", "edit_module_candidate")
	script := "export function search(){return 1}"
	if err := validAuthorMetadata(a, &script); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"read_module_candidate_part", "edit_module_candidate"} {
		if !allowedPlatformTool(a, name) || platformServerTool(name) {
			t.Fatal("wrong editor routing")
		}
		if !authorProgressPattern.MatchString("author:tool:1:" + name + ":succeeded") {
			t.Fatal("missing bounded progress enum")
		}
	}
}
