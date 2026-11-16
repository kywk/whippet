package server

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestM12AuthorSnapshotUTF8AndImmutableRead(t *testing.T) {
	raw, err := os.ReadFile(repositoryFile("contracts", "testdata", "author-snapshot.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		BaseRevision int    `json:"baseRevision"`
		SHA256       string `json:"sha256"`
		Chunks       []struct {
			Text   string `json:"text"`
			Repeat int    `json:"repeat"`
		} `json:"chunks"`
		PageBytes     []int `json:"pageBytes"`
		InvalidOffset int   `json:"invalidOffset"`
	}
	if json.Unmarshal(raw, &vector) != nil {
		t.Fatal("invalid vector")
	}
	source := ""
	for _, chunk := range vector.Chunks {
		source += strings.Repeat(chunk.Text, chunk.Repeat)
	}
	input := AuthorInput{SkillID: "test-author", BaseRevision: vector.BaseRevision}
	args := func(offset any) json.RawMessage {
		value, _ := json.Marshal(map[string]any{"component": "script", "sha256": vector.SHA256, "offsetBytes": offset})
		return value
	}
	first, err := readAuthorSnapshot(source, input, args(0))
	if err != nil || len(first.Content) != vector.PageBytes[0] || first.NextOffsetBytes == nil {
		t.Fatal("first page", err)
	}
	second, err := readAuthorSnapshot(source, input, args(*first.NextOffsetBytes))
	if err != nil || len(second.Content) != vector.PageBytes[1] || second.NextOffsetBytes != nil || first.Content+second.Content != source {
		t.Fatal("second page", err)
	}
	full, err := readAuthorSnapshot(source, input, args(nil))
	if err != nil || full.Content != source || full.SHA256 != scriptHash(source) || full.BaseRevision != 7 {
		t.Fatal("full source", err)
	}
	moduleInput := AuthorInput{SkillID: "module-authoring", BaseRevision: 7, Platform: &AuthorPlatform{Module: &Module{Harness: "frozen harness"}}}
	harnessArgs, _ := json.Marshal(map[string]any{"component": "harness", "sha256": scriptHash("frozen harness"), "offsetBytes": nil})
	if page, err := readAuthorSnapshot(source, moduleInput, harnessArgs); err != nil || page.Content != "frozen harness" {
		t.Fatal("frozen harness", err)
	}
	if _, err := readAuthorSnapshot(source, input, harnessArgs); err == nil {
		t.Fatal("ordinary Test exposed a harness")
	}
	for _, bad := range []json.RawMessage{args(-1), args(vector.InvalidOffset), args(len(source) + 1), args(0.5), args("0"), []byte(`{"component":"script","sha256":"wrong","offsetBytes":null}`), []byte(`{"component":"script","sha256":"wrong"}`), []byte(`{"component":"script","component":"harness","sha256":"wrong","offsetBytes":null}`)} {
		if _, err = readAuthorSnapshot(source, input, bad); err == nil {
			t.Fatal("invalid read accepted")
		}
	}
	input.SkillID = "workspace-author"
	if _, err = readAuthorSnapshot(source, input, args(0)); err == nil {
		t.Fatal("wrong role accepted")
	}
}

func TestM12AuthorSnapshotToolPolicy(t *testing.T) {
	t.Setenv("WHIPPET_SKILLS_PATH", repositoryFile("runtimes", "worker", "skills"))
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	tool, ok := registry.tool("read_author_snapshot")
	if !ok || tool.Side != "worker" || tool.Effect != "read" {
		t.Fatal("snapshot tool missing")
	}
	for _, offset := range []any{nil, 0, 8192} {
		raw, _ := json.Marshal(map[string]any{"component": "script", "sha256": strings.Repeat("a", 64), "offsetBytes": offset})
		if _, err := validateToolArguments(tool, raw); err != nil {
			t.Fatal("legal snapshot args rejected")
		}
	}
	for _, skill := range []string{"test-author", "module-authoring", "usecase-planner", "workspace-author", "acceptance-summary"} {
		input := AuthorInput{SkillID: skill, AllowedTools: []string{}}
		if err = snapshotAuthor(&input); err != nil {
			t.Fatal(skill, err)
		}
		found := false
		for _, name := range input.AllowedTools {
			found = found || name == "read_author_snapshot"
		}
		if found != (skill == "test-author" || skill == "module-authoring") {
			t.Fatal("wrong role grant", skill)
		}
	}
}
