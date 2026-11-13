package manager

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func moduleSummaryFixture(t *testing.T) Dispatch {
	d := m7Dispatch(t, true)
	a := d.Author
	registry, e := loadToolRegistry()
	if e != nil {
		t.Fatal(e)
	}
	a.ToolRegistryVersion = &registry.Version
	a.ToolRegistrySHA256 = &registry.SHA256
	actualSkillPin(t, a)
	d.Script = "export function search(){return 1}"
	module := moduleFixture()
	harness := module["harness"].(string)
	a.ValidationEvidence.ScriptHash = fmt.Sprintf("%x", sha256.Sum256([]byte(harness)))
	a.ModuleSummary, _ = json.Marshal(map[string]any{"schemaVersion": 1, "module": module, "bundleHash": strings.Repeat("a", 64), "bodyHash": fmt.Sprintf("%x", sha256.Sum256([]byte(d.Script))), "harnessHash": a.ValidationEvidence.ScriptHash})
	return d
}
func TestM10ModuleSummaryStrictHashesAndForwarding(t *testing.T) {
	d := moduleSummaryFixture(t)
	a := d.Author
	if validAuthorMetadata(a, &d.Script) != nil {
		t.Fatal("valid Module summary rejected")
	}
	raw, _ := json.Marshal(WorkerInput{Author: a, Script: d.Script})
	var restored WorkerInput
	if json.Unmarshal(raw, &restored) != nil || string(restored.Author.ModuleSummary) != string(a.ModuleSummary) {
		t.Fatal("snapshot changed during forwarding")
	}
	original := append(json.RawMessage(nil), a.ModuleSummary...)
	for _, mutate := range []func(map[string]any){func(s map[string]any) { s["bodyHash"] = strings.Repeat("b", 64) }, func(s map[string]any) { s["harnessHash"] = strings.Repeat("c", 64) }, func(s map[string]any) { s["unknown"] = 1 }, func(s map[string]any) { s["module"].(map[string]any)["harness"] = strings.Repeat("x", 2<<20+1) }, func(s map[string]any) { s["bundleHash"] = nil }} {
		var s map[string]any
		_ = json.Unmarshal(original, &s)
		mutate(s)
		a.ModuleSummary, _ = json.Marshal(s)
		if validAuthorMetadata(a, &d.Script) == nil {
			t.Fatal("invalid module summary accepted")
		}
	}
	a.ModuleSummary = json.RawMessage("null")
	if validAuthorMetadata(a, &d.Script) == nil {
		t.Fatal("null accepted")
	}
	a.ModuleSummary = original
	a.Batch = json.RawMessage("null")
	if validAuthorMetadata(a, &d.Script) == nil {
		t.Fatal("batch coexistence accepted")
	}
	a.Batch = nil
	a.Platform = json.RawMessage("null")
	if validAuthorMetadata(a, &d.Script) == nil {
		t.Fatal("platform coexistence accepted")
	}
	a.Platform = nil
	a.ValidationEvidence.ScriptHash = fmt.Sprintf("%x", sha256.Sum256([]byte(d.Script)))
	if validAuthorMetadata(a, &d.Script) == nil {
		t.Fatal("body evidence hash accepted instead of harness")
	}
	ordinary := v10Author(t)
	ordinary.ModuleSummary = original
	if validAuthorMetadata(ordinary, nil) == nil {
		t.Fatal("other primary accepted")
	}
}

func TestM10ModuleSummaryRawAndEscapedLimits(t *testing.T) {
	d := moduleSummaryFixture(t)
	d.Script = strings.Repeat("\x01", 2<<20)
	module := moduleFixture()
	module["harness"] = d.Script
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(d.Script)))
	d.Author.ValidationEvidence.ScriptHash = hash
	snapshot := map[string]any{"schemaVersion": 1, "module": module, "bundleHash": strings.Repeat("a", 64), "bodyHash": hash, "harnessHash": hash}
	d.Author.ModuleSummary, _ = json.Marshal(snapshot)
	raw, _ := json.Marshal(WorkerInput{Author: d.Author, Script: d.Script})
	if len(raw) <= 13<<20 || !validModuleSummary(d.Author, &d.Script) {
		t.Fatal("two raw-limit files should fit input64MiB")
	}
	d.Script += "x"
	snapshot["bodyHash"] = fmt.Sprintf("%x", sha256.Sum256([]byte(d.Script)))
	d.Author.ModuleSummary, _ = json.Marshal(snapshot)
	if validModuleSummary(d.Author, &d.Script) {
		t.Fatal("body raw overflow accepted")
	}
	d.Script = d.Script[:len(d.Script)-1]
	snapshot["bodyHash"] = hash
	module["harness"] = d.Script + "x"
	snapshot["harnessHash"] = fmt.Sprintf("%x", sha256.Sum256([]byte(module["harness"].(string))))
	d.Author.ValidationEvidence.ScriptHash = snapshot["harnessHash"].(string)
	d.Author.ModuleSummary, _ = json.Marshal(snapshot)
	if validModuleSummary(d.Author, &d.Script) {
		t.Fatal("harness raw overflow accepted")
	}
}
