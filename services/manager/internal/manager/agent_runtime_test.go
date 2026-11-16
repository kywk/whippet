package manager

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestM12RuntimeStrictForwarding(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("../../../../contracts/testdata/agent-runtime.json"))
	if err != nil || !validRuntimeSnapshot(raw) {
		t.Fatal("runtime digest contract", err)
	}
	a := v10Author(t)
	a.Runtime = raw
	if err := validAuthorMetadata(a, nil); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(a)
	var restored AuthorTask
	if json.Unmarshal(body, &restored) != nil || validAuthorMetadata(&restored, nil) != nil {
		t.Fatal("round trip")
	}
	var before, after any
	json.Unmarshal(raw, &before)
	json.Unmarshal(restored.Runtime, &after)
	if jsonTextForRuntime(before) != jsonTextForRuntime(after) {
		t.Fatal("runtime mutated")
	}
	for _, value := range []string{"null", strings.Replace(string(raw), `"model": "muse-spark-1.3-contributor"`, `"model": "changed"`, 1), strings.Replace(string(raw), `"schemaVersion": 1`, `"schemaVersion": 1, "apiKey": "forbidden"`, 1), strings.Replace(string(raw), `"engine": "vercel"`, `"engine": "builtin", "engine": "vercel"`, 1)} {
		a.Runtime = json.RawMessage(value)
		if validAuthorMetadata(a, nil) == nil {
			t.Fatal("invalid runtime accepted")
		}
		body, _ = json.Marshal(a)
		if json.Unmarshal(body, &restored) == nil {
			t.Fatal("invalid runtime decoded")
		}
	}
	a = v10Author(t)
	a.Runtime = raw
	a.Model = nil
	if _, err := validCapabilitySnapshot(a); err == nil {
		t.Fatal("runtime without capability")
	}
}
func jsonTextForRuntime(value any) string { raw, _ := json.Marshal(value); return string(raw) }
