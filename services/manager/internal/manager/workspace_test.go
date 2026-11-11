package manager

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const workspaceSnapshotFixture = `{"revision":7,"sites":[{"name":"固定站","url":"http://127.0.0.1:18765/base/"}],"defaultTestUrl":"http://127.0.0.1:18765/base/","timeoutMs":60000}`

func TestM5WorkspaceSnapshotPassThroughAndLegacyInput(t *testing.T) {
	m, _, _ := lifecycleManager(t, 1)
	for _, kind := range []string{"run", "author"} {
		for _, snapshot := range []json.RawMessage{nil, json.RawMessage(workspaceSnapshotFixture)} {
			d := authorDispatch()
			d.Kind = kind
			if kind == "run" {
				d.Script = "synthetic spec"
				d.Author = nil
				d.TimeoutMS = 60000
			}
			d.WorkspaceSettings = snapshot
			if err := validDispatch(d); err != nil {
				t.Fatal(err)
			}
			r := record{RunID: newID(), AttemptID: newID(), Kind: kind}
			if err := m.prepare(r, d); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filepath.Join(m.taskDir(r), "input.json"))
			if err != nil {
				t.Fatal(err)
			}
			var input WorkerInput
			if err := json.Unmarshal(data, &input); err != nil {
				t.Fatal(err)
			}
			if string(input.WorkspaceSettings) != string(snapshot) {
				t.Fatal("Workspace snapshot changed or was dropped")
			}
			if snapshot == nil && strings.Contains(string(data), "workspaceSettings") {
				t.Fatal("legacy input gained Workspace field")
			}
			if input.TimeoutMS != d.TimeoutMS || kind == "author" && input.TimeoutMS != 180000 {
				t.Fatal("Workspace timeout overrode author execution budget")
			}
			if strings.Contains(string(data), "OPENCODE_API_KEY") {
				t.Fatal("AI setting appeared in Worker snapshot")
			}
		}
	}
}

func TestM5WorkspaceSnapshotRejectsInvalidOrSecretFields(t *testing.T) {
	for _, snapshot := range []string{`null`, strings.Replace(workspaceSnapshotFixture, `"revision":7`, `"revision":0`, 1),
		strings.Replace(workspaceSnapshotFixture, `"timeoutMs":60000`, `"timeoutMs":3600001`, 1),
		strings.Replace(workspaceSnapshotFixture, `"name":"固定站"`, `"name":"固定站","env":"synthetic-only"`, 1),
		strings.Replace(workspaceSnapshotFixture, `"revision":7`, `"revision":7,"OPENCODE_API_KEY":"synthetic-only"`, 1),
		strings.ReplaceAll(workspaceSnapshotFixture, `http://127.0.0.1:18765/base/`, `https://user:synthetic-only@example.test/`)} {
		d := authorDispatch()
		d.WorkspaceSettings = json.RawMessage(snapshot)
		if err := validDispatch(d); err == nil || strings.Contains(err.Error(), "synthetic-only") {
			t.Fatal("invalid Workspace snapshot accepted or error echoed input")
		}
	}
}
