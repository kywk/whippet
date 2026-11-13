package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestM10RegistryAndHarnessRequest(t *testing.T) {
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	if registry.Version == "" || !sha256Hex(registry.SHA256) {
		t.Fatal("missing registry snapshot")
	}
	request := HarnessToolRequest{CallID: NewID(), Name: "read_conversation_history", Arguments: json.RawMessage(`{"cursor":null}`)}
	data, _ := json.Marshal(request)
	if _, _, err := decodeHarnessRequest(data, registry); err != nil {
		t.Fatal(err)
	}
	for _, args := range []string{`{}`, `{"cursor":null,"workspaceId":"other"}`, `{"cursor":42}`, `null`} {
		request.Arguments = json.RawMessage(args)
		data, _ = json.Marshal(request)
		if _, _, err := decodeHarnessRequest(data, registry); err == nil {
			t.Fatalf("accepted %s", args)
		}
	}
	request.Name = "update_draft"
	request.Arguments = json.RawMessage(`{}`)
	data, _ = json.Marshal(request)
	if _, _, err := decodeHarnessRequest(data, registry); err == nil {
		t.Fatal("worker tool accepted")
	}
	request.Name = "catalog_search"
	data, _ = json.Marshal(request)
	if _, _, err := decodeHarnessRequest(data, registry); err == nil {
		t.Fatal("invalid platform arguments accepted")
	}
}
func TestM10HarnessSnapshotCannotDowngrade(t *testing.T) {
	r, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	input := AuthorInput{SkillID: "test-author", SkillVersion: "1", Skills: []SkillSnapshot{{ID: "test-author", Version: "1", SHA256: strings.Repeat("a", 64), ManifestSHA256: strings.Repeat("b", 64), ReferenceHashes: map[string]string{}}}, Budget: &AuthorBudget{MaxModelRequests: 1, MaxToolCalls: 1, MaxDurationMS: 1000}, Model: &AuthorModel{Provider: "opencode", Model: "configured-model"}, AllowedTools: []string{"read_conversation_history"}, ToolRegistryVersion: r.Version, ToolRegistrySHA256: r.SHA256}
	if err := validateToolSnapshot(input, r, "read_conversation_history"); err != nil {
		t.Fatal(err)
	}
	input.ToolRegistrySHA256 = ""
	if validateToolSnapshot(input, r, "read_conversation_history") == nil {
		t.Fatal("partial snapshot accepted")
	}
	input.ToolRegistrySHA256 = r.SHA256
	input.AllowedTools = []string{}
	if validateToolSnapshot(input, r, "read_conversation_history") == nil {
		t.Fatal("ungranted capability accepted")
	}
}
