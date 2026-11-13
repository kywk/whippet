package manager

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func partialValue(script *string) map[string]any {
	partial := map[string]any{"reason": "budget_exhausted", "nextStep": "繼續驗證"}
	out := map[string]any{"message": "保留候選", "requestValidation": false, "partial": partial}
	if script != nil {
		out["script"] = *script
		partial["checkpoint"] = map[string]any{"scriptHash": fmt.Sprintf("%x", sha256.Sum256([]byte(*script))), "selfTestPassed": true}
	}
	return out
}
func writePartial(t *testing.T, dir string, value any) {
	t.Helper()
	if err := atomicJSON(filepath.Join(dir, "output/author.json"), value); err != nil {
		t.Fatal(err)
	}
}
func TestM10PartialArtifactSchemaHashAndPermission(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "output"), 0700); err != nil {
		t.Fatal(err)
	}
	a := m7Dispatch(t, false).Author
	script := "import {test} from '@playwright/test'; test('ok',()=>{});"
	for _, candidate := range []*string{nil, &script} {
		writePartial(t, dir, partialValue(candidate))
		if !validAuthorArtifact(dir, a, nil) {
			t.Fatal("valid partial rejected")
		}
	}
	cases := map[string]func(map[string]any){
		"reason":         func(v map[string]any) { v["partial"].(map[string]any)["reason"] = "cancelled" },
		"empty-step":     func(v map[string]any) { v["partial"].(map[string]any)["nextStep"] = " " },
		"large-step":     func(v map[string]any) { v["partial"].(map[string]any)["nextStep"] = strings.Repeat("字", 2731) },
		"validation":     func(v map[string]any) { v["requestValidation"] = true },
		"no-script":      func(v map[string]any) { delete(v, "script") },
		"null-script":    func(v map[string]any) { v["script"] = nil },
		"changed-script": func(v map[string]any) { v["script"] = "changed by redaction" },
		"uppercase-hash": func(v map[string]any) {
			v["partial"].(map[string]any)["checkpoint"].(map[string]any)["scriptHash"] = strings.Repeat("A", 64)
		},
		"false-self-test": func(v map[string]any) {
			v["partial"].(map[string]any)["checkpoint"].(map[string]any)["selfTestPassed"] = false
		},
		"null-self-test": func(v map[string]any) {
			v["partial"].(map[string]any)["checkpoint"].(map[string]any)["selfTestPassed"] = nil
		},
		"no-checkpoint":   func(v map[string]any) { delete(v["partial"].(map[string]any), "checkpoint") },
		"null-checkpoint": func(v map[string]any) { v["partial"].(map[string]any)["checkpoint"] = nil },
		"null-partial":    func(v map[string]any) { v["partial"] = nil },
		"unknown-partial": func(v map[string]any) { v["partial"].(map[string]any)["appliedRevision"] = 2 },
		"unknown-checkpoint": func(v map[string]any) {
			v["partial"].(map[string]any)["checkpoint"].(map[string]any)["approved"] = true
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			v := partialValue(&script)
			mutate(v)
			writePartial(t, dir, v)
			if validAuthorArtifact(dir, a, nil) {
				t.Fatal("invalid partial accepted")
			}
		})
	}
	noPin := partialValue(nil)
	noPin["script"] = nil
	writePartial(t, dir, noPin)
	if validAuthorArtifact(dir, a, nil) {
		t.Fatal("null script without checkpoint accepted")
	}
	writePartial(t, dir, partialValue(&script))
	*a.AllowedTools = []string{}
	if validAuthorArtifact(dir, a, nil) {
		t.Fatal("checkpoint without update_draft permission")
	}
	writePartial(t, dir, partialValue(nil))
	for _, kind := range []string{"workspace-author", "acceptance-summary", "module-authoring"} {
		a.SkillID = &kind
		if validAuthorArtifact(dir, a, nil) {
			t.Fatal("partial accepted outside supported author")
		}
	}
}
func TestM10AuthorArtifact13MiBReadOpenUploadAndRawScriptLimit(t *testing.T) {
	m, _, _ := lifecycleManager(t, 1)
	d := m7Dispatch(t, false)
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Author: d.Author}
	dir := m.taskDir(r)
	if err := os.MkdirAll(filepath.Join(dir, "output"), 0700); err != nil {
		t.Fatal(err)
	}
	script := "//" + strings.Repeat("\x01", maxScriptBytes-2)
	value := partialValue(&script)
	writePartial(t, dir, value)
	file := filepath.Join(dir, "output/author.json")
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 12<<20 || len(raw) > maxAuthorArtifactBytes {
		t.Fatal("fixture did not exercise escaping expansion")
	}
	if !validAuthorArtifact(dir, d.Author, nil) {
		t.Fatal("large valid candidate rejected")
	}
	var received int64
	m.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		received, _ = io.Copy(io.Discard, req.Body)
		if received != req.ContentLength {
			t.Error("upload length mismatch")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	if err := m.upload(context.Background(), r, "author.json"); err != nil || received != int64(len(raw)) {
		t.Fatal("large artifact upload failed", err)
	}
	exact := append(append([]byte(nil), raw...), []byte(strings.Repeat(" ", maxAuthorArtifactBytes-len(raw)))...)
	if err := os.WriteFile(file, exact, 0600); err != nil {
		t.Fatal(err)
	}
	var parsed json.RawMessage
	if readOutput(dir, "author.json", &parsed) != nil || !validAuthorArtifact(dir, d.Author, nil) {
		t.Fatal("exact 13MiB rejected")
	}
	if err := os.WriteFile(file, append(exact, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if f, err := openArtifact(dir, "author.json"); err == nil {
		f.Close()
		t.Fatal("oversize open accepted")
	}
	if readOutput(dir, "author.json", &parsed) == nil || validAuthorArtifact(dir, d.Author, nil) || m.upload(context.Background(), r, "author.json") == nil {
		t.Fatal("oversize artifact escaped a receiving path")
	}
	tooLarge := script + "x"
	writePartial(t, dir, partialValue(&tooLarge))
	if validAuthorArtifact(dir, d.Author, nil) {
		t.Fatal("raw script limit expanded with envelope")
	}
}
