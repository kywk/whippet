package manager

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func v10Author(t *testing.T) *AuthorTask {
	t.Helper()
	d := m7Dispatch(t, false)
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	a := d.Author
	a.ToolRegistryVersion = &registry.Version
	a.ToolRegistrySHA256 = &registry.SHA256
	a.Skills = json.RawMessage(`[{"id":"test-author","version":"1","sha256":"` + strings.Repeat("a", 64) + `","manifestSha256":"` + strings.Repeat("b", 64) + `","referenceHashes":{}}]`)
	a.Budget = json.RawMessage(`{"maxModelRequests":8,"maxToolCalls":12,"maxDurationMs":180000}`)
	a.Model = json.RawMessage(`{"provider":"opencode","model":"muse-spark-1.3-contributor","reasoningEffort":"high"}`)
	*a.AllowedTools = append(*a.AllowedTools, "read_skill_reference")
	return a
}
func TestV10RegistrySnapshotForwardingAndHash(t *testing.T) {
	a := v10Author(t)
	if err := validAuthorMetadata(a, nil); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	var restored AuthorTask
	if err = json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if err = validAuthorMetadata(&restored, nil); err != nil {
		t.Fatal(err)
	}
	if string(a.Skills) != string(restored.Skills) || string(a.Budget) != string(restored.Budget) || *a.ToolRegistrySHA256 != *restored.ToolRegistrySHA256 {
		t.Fatal("capability changed")
	}
	wrong := strings.Repeat("0", 64)
	restored.ToolRegistrySHA256 = &wrong
	if validAuthorMetadata(&restored, nil) == nil {
		t.Fatal("accepted registry drift")
	}
}
func TestV10RegistryRejectsPartialNullAndUnregistered(t *testing.T) {
	a := v10Author(t)
	raw, _ := json.Marshal(a)
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	for _, key := range []string{"skills", "budget", "model", "toolRegistryVersion", "toolRegistrySha256"} {
		saved := fields[key]
		for _, value := range []json.RawMessage{nil, json.RawMessage("null")} {
			if value == nil {
				delete(fields, key)
			} else {
				fields[key] = value
			}
			raw, _ := json.Marshal(fields)
			var bad AuthorTask
			if json.Unmarshal(raw, &bad) == nil {
				t.Fatalf("accepted partial/null %s", key)
			}
		}
		fields[key] = saved
	}
	a.Budget = json.RawMessage(`{"maxModelRequests":8,"maxToolCalls":null,"maxDurationMs":180000}`)
	if validAuthorMetadata(a, nil) == nil {
		t.Fatal("accepted null tool budget")
	}
	a = v10Author(t)
	*a.AllowedTools = append(*a.AllowedTools, "future_unimplemented")
	if validAuthorMetadata(a, nil) == nil {
		t.Fatal("accepted unimplemented tool")
	}
}
func TestV10RegistryMissingFailsClosedAndLegacyRemainsValid(t *testing.T) {
	t.Setenv("WHIPPET_TOOL_REGISTRY_PATH", filepath.Join(t.TempDir(), "absent.json"))
	if _, err := loadToolRegistry(); err == nil {
		t.Fatal("missing registry accepted")
	}
	d := m7Dispatch(t, false)
	if err := validAuthorMetadata(d.Author, nil); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "invalid.json")
	if err := os.WriteFile(path, []byte(`{"schemaVersion":1,"version":"10.0","tools":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WHIPPET_TOOL_REGISTRY_PATH", path)
	if _, err := loadToolRegistry(); err == nil {
		t.Fatal("invalid registry accepted")
	}
}
