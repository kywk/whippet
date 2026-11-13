package manager

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestM105BatchSummaryStrictSnapshotAndForwarding(t *testing.T) {
	d := m7Dispatch(t, true)
	a := d.Author
	registry, e := loadToolRegistry()
	if e != nil {
		t.Fatal(e)
	}
	a.ToolRegistryVersion = &registry.Version
	a.ToolRegistrySHA256 = &registry.SHA256
	actualSkillPin(t, a)
	testID := newID()
	d.TestID, _ = json.Marshal(testID)
	d.WorkspaceID = newID()
	module := moduleFixture()
	delete(module, "harness")
	b := map[string]any{"schemaVersion": 1, "planId": newID(), "planRevision": 1, "batchHash": strings.Repeat("a", 64), "usecase": map[string]any{"testId": testID, "editingSessionId": *a.EditingSessionID, "revision": a.BaseRevision, "contextRevision": *a.ContextRevision, "bundleHash": strings.Repeat("b", 64), "validationEvidence": a.ValidationEvidence}, "modules": []any{map[string]any{"testId": newID(), "versionId": newID(), "mode": "reuse", "editingSessionId": nil, "revision": a.BaseRevision, "contextRevision": 0, "bundleHash": strings.Repeat("b", 64), "name": "Module", "description": nil, "module": module, "harnessHash": strings.Repeat("c", 64), "validationEvidence": a.ValidationEvidence}}}
	a.Batch, _ = json.Marshal(b)
	if !validAuthorBatch(a) || validAuthorMetadata(a, &d.Script) != nil {
		t.Fatal("valid batch rejected")
	}
	raw, _ := json.Marshal(WorkerInput{Author: a})
	var restored WorkerInput
	if json.Unmarshal(raw, &restored) != nil || !reflect.DeepEqual(a.Batch, restored.Author.Batch) {
		t.Fatal("batch changed in transfer")
	}
	saved := append(json.RawMessage(nil), a.Batch...)
	for _, raw := range []json.RawMessage{[]byte("null"), []byte(`{}`), []byte(`{"extra":1}`)} {
		a.Batch = raw
		if validAuthorBatch(a) {
			t.Fatal("invalid batch accepted")
		}
	}
	a.Batch = saved
	ordinary := v10Author(t)
	ordinary.Batch = saved
	if validAuthorMetadata(ordinary, nil) == nil {
		t.Fatal("other primary batch accepted")
	}
	modules := b["modules"].([]any)
	b["modules"] = append(modules, modules[0])
	a.Batch, _ = json.Marshal(b)
	if validAuthorBatch(a) {
		t.Fatal("duplicate module accepted")
	}
	b["modules"] = modules
	modules[0].(map[string]any)["editingSessionId"] = newID()
	a.Batch, _ = json.Marshal(b)
	if validAuthorBatch(a) {
		t.Fatal("reuse session accepted")
	}
	modules[0].(map[string]any)["editingSessionId"] = nil
	modules[0].(map[string]any)["name"] = strings.Repeat("x", 4<<20)
	a.Batch, _ = json.Marshal(b)
	if validAuthorBatch(a) {
		t.Fatal("oversized batch accepted")
	}
}
