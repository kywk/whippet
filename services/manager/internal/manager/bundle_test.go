package manager

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func bundleDispatch() Dispatch {
	return Dispatch{Kind: "run", TimeoutMS: 20000, Files: []RunFile{{Path: "tests/test.spec.ts", Content: "import '@lib/setup';", Origin: "manual"}, {Path: "lib/setup.ts", Content: "export const x=1", Origin: "manual"}}}
}
func TestV10BundleValidationAndMixedOrigin(t *testing.T) {
	d := bundleDispatch()
	if err := validDispatch(d); err != nil {
		t.Fatal(err)
	}
	if err := normalizeBundle(&d); err != nil || d.ScriptOrigin != "manual" || d.Script != d.Files[0].Content {
		t.Fatal("entry not normalized", err)
	}
	d.Files[1].Origin = "ai"
	if err := normalizeBundle(&d); err != nil || d.ScriptOrigin != "ai" {
		t.Fatal("mixed origin was trusted as manual", err)
	}
	for _, path := range []string{"lib/../bad.ts", "/tmp/a.ts", "lib\\bad.ts", "lib/Bad.ts", "tests/other.spec.ts"} {
		bad := bundleDispatch()
		bad.Files[1].Path = path
		if validDispatch(bad) == nil {
			t.Fatal("accepted path", path)
		}
	}
	for _, mutate := range []func(*Dispatch){
		func(d *Dispatch) { d.Files = append(d.Files, d.Files[0]) }, func(d *Dispatch) { d.Files = d.Files[1:] },
		func(d *Dispatch) { d.Script = "mismatch" }, func(d *Dispatch) { d.Files[1].Origin = "legacy" },
		func(d *Dispatch) { d.Files[1].Content = strings.Repeat("x", maxScriptBytes+1) },
		func(d *Dispatch) { d.Kind = "author" },
	} {
		bad := bundleDispatch()
		mutate(&bad)
		if validDispatch(bad) == nil {
			t.Fatal("accepted invalid bundle")
		}
	}
	d.WorkspaceID = newID()
	d.TestID = json.RawMessage(`"` + newID() + `"`)
	d.WorkspaceContext, _ = json.Marshal(map[string]any{"schemaVersion": "1", "workspaceId": d.WorkspaceID, "settingsRevision": 1, "config": nil, "roleRefs": []any{}})
	if validDispatch(d) == nil {
		t.Fatal("AI module bypassed workspace scope with manual entry")
	}
}
func TestV10BundleWireAndWorkerInput(t *testing.T) {
	m, _, _ := lifecycleManager(t, 1)
	d := bundleDispatch()
	d.Files[1].Origin = "ai"
	// Omitted script is legal; an explicitly mismatching or null script is not.
	raw, _ := json.Marshal(map[string]any{"kind": "run", "files": d.Files, "timeoutMs": 20000})
	var decoded Dispatch
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Script != d.Files[0].Content || decoded.ScriptOrigin != "ai" {
		t.Fatal("wire normalization failed")
	}
	for _, script := range []any{"", nil, "wrong"} {
		raw, _ := json.Marshal(map[string]any{"kind": "run", "files": d.Files, "script": script, "timeoutMs": 20000})
		if json.Unmarshal(raw, new(Dispatch)) == nil {
			t.Fatal("accepted inconsistent script")
		}
	}
	if json.Unmarshal([]byte(`{"kind":"run","files":null,"script":"old","timeoutMs":20000}`), new(Dispatch)) == nil {
		t.Fatal("accepted null files")
	}
	r := record{RunID: newID(), AttemptID: newID(), Kind: "run", Phase: "accepted", TimeoutMS: 20000}
	if err := m.prepare(r, d); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(m.taskDir(r), "input.json"))
	if err != nil {
		t.Fatal(err)
	}
	var input WorkerInput
	if err = json.Unmarshal(body, &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Files) != 2 || input.Script != d.Files[0].Content || input.ScriptOrigin != "ai" {
		t.Fatal("bundle lost on Manager forwarding")
	}
}
