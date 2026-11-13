package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func m10SkillRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	source := repositoryFile("runtimes", "worker", "skills")
	for _, id := range []string{"test-author", "workspace-author", "acceptance-summary", "playwright-authoring", "module-authoring", "usecase-planner"} {
		err := filepath.WalkDir(filepath.Join(source, id), func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(source, path)
			if err != nil {
				return err
			}
			dest := filepath.Join(root, relative)
			if entry.IsDir() {
				return os.MkdirAll(dest, 0700)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			return os.WriteFile(dest, data, 0600)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("WHIPPET_SKILLS_PATH", root)
	t.Setenv("WHIPPET_AI_MODEL", "muse-spark-1.3-contributor")
	return root
}
func TestM10SkillSnapshotPolicyAndDrift(t *testing.T) {
	root := m10SkillRoot(t)
	input := AuthorInput{SkillID: "test-author", AllowedTools: []string{"read_draft", "read_conversation_history", "unknown_tool"}}
	if err := snapshotAuthor(&input); err != nil {
		t.Fatal(err)
	}
	if len(input.Skills) != 2 || input.Skills[0].ID != "test-author" || input.Skills[1].ID != "playwright-authoring" || input.Skills[1].ReferenceHashes["recipe"] == "" {
		t.Fatal("recipe pins missing")
	}
	if input.Model.Provider != "opencode" || input.Budget.MaxModelRequests != 8 {
		t.Fatal("primary policy missing")
	}
	if strings.Join(input.AllowedTools, ",") != "read_conversation_history,read_draft,read_skill_reference" {
		t.Fatalf("policy widened %v", input.AllowedTools)
	}
	prior := input.Skills[0].SHA256
	path := filepath.Join(root, "test-author", "SKILL.md")
	if err := os.WriteFile(path, []byte("new valid skill"), 0600); err != nil {
		t.Fatal(err)
	}
	next := AuthorInput{SkillID: "test-author", AllowedTools: []string{}}
	if err := snapshotAuthor(&next); err != nil {
		t.Fatal(err)
	}
	if next.Skills[0].SHA256 == prior || input.Skills[0].SHA256 != prior {
		t.Fatal("enqueue did not snapshot new bytes independently")
	}
	data, _ := json.Marshal(input)
	if strings.Contains(string(data), "apiKey") || strings.Contains(string(data), "baseURL") {
		t.Fatal("provider secrets leaked")
	}
	if err := os.WriteFile(filepath.Join(root, "playwright-authoring", "references", "recipe.md"), []byte("drift"), 0600); err != nil {
		t.Fatal(err)
	}
	if snapshotAuthor(&next) == nil {
		t.Fatal("mismatched reference accepted")
	}
}
func TestM10SkillLimitsAndSummaryZeroTools(t *testing.T) {
	root := m10SkillRoot(t)
	input := AuthorInput{SkillID: "acceptance-summary", AllowedTools: []string{}}
	if err := snapshotAuthor(&input); err != nil {
		t.Fatal(err)
	}
	if len(input.Skills) != 1 || input.Budget.MaxToolCalls != 0 || len(input.AllowedTools) != 0 {
		t.Fatal("summary gained tools")
	}
	path := filepath.Join(root, "test-author", "SKILL.md")
	for _, size := range []int{8192, 8193} {
		if err := os.WriteFile(path, []byte(strings.Repeat("a", size)), 0600); err != nil {
			t.Fatal(err)
		}
		input = AuthorInput{SkillID: "test-author"}
		err := snapshotAuthor(&input)
		if (size == 8192) != (err == nil) {
			t.Fatalf("size %d: %v", size, err)
		}
	}
	t.Setenv("WHIPPET_AI_MODEL", "different-model")
	input = AuthorInput{SkillID: "acceptance-summary"}
	if snapshotAuthor(&input) == nil {
		t.Fatal("backend model mismatch accepted")
	}
}
func TestM10SkillPathEscapeAndSymlink(t *testing.T) {
	root := m10SkillRoot(t)
	for _, path := range []string{"../outside", "/etc/passwd", "test-author/../SKILL.md", "test-author\\SKILL.md"} {
		if _, err := readSkillFile(root, path, 8192); err == nil {
			t.Fatal("escape accepted", path)
		}
	}
	if err := os.Symlink(filepath.Join(root, "test-author", "SKILL.md"), filepath.Join(root, "link.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := readSkillFile(root, "link.md", 8192); err == nil {
		t.Fatal("symlink accepted")
	}
}
