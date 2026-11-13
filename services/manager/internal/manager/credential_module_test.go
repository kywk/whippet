package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func nodeModuleArtifact(t *testing.T, dir string) []byte {
	t.Helper()
	entry := os.Getenv("WHIPPET_M10_WORKER_ENTRY")
	if entry == "" {
		_, source, _, _ := runtime.Caller(0)
		entry = filepath.Join(filepath.Dir(source), "../../../../runtimes/worker/dist/author/main.js")
	}
	types := (&url.URL{Scheme: "file", Path: filepath.Join(filepath.Dir(entry), "types.js")}).String()
	code := `import {writeFileSync} from 'node:fs';const {serializeAuthorArtifact}=await import(process.argv[1]);const value={message:'synthetic clean success',script:'export function search(){return 1}',module:{slug:'search',moduleKind:'step',exportName:'search',signature:'',inputs:'',returns:'',preconditions:'',postconditions:'',harness:"import {test,expect} from '@playwright/test';import {search} from '@lib/search';test('intent',()=>expect(search()).toBe(1));"},requestValidation:false};writeFileSync(process.argv[2],serializeAuthorArtifact(value,'module-authoring'));`
	if err := exec.Command("node", "--input-type=module", "-e", code, types, filepath.Join(dir, "output/author.json")).Run(); err != nil {
		t.Fatal("Worker serializer fixture failed")
	}
	data, err := os.ReadFile(filepath.Join(dir, "output/author.json"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestModuleCredentialCleanWorkerSerializationPreservesBytes(t *testing.T) {
	a := platformAuthorFixture(t, "module-authoring")
	dir := t.TempDir()
	if os.Mkdir(filepath.Join(dir, "output"), 0700) != nil {
		t.Fatal("fixture dir")
	}
	original := nodeModuleArtifact(t, dir)
	if !bytes.HasSuffix(original, []byte("\n")) {
		t.Fatal("not Worker format")
	}
	for _, data := range [][]byte{original, append([]byte(" \n"), original...), []byte(`{"requestValidation":false,"module":{"harness":"synthetic","postconditions":"","preconditions":"","returns":"","inputs":"","signature":"","exportName":"search","moduleKind":"step","slug":"search"},"script":"synthetic","message":"clean"}`)} {
		if os.WriteFile(filepath.Join(dir, "output/author.json"), data, 0600) != nil {
			t.Fatal("fixture write")
		}
		if err := sanitizeCredentialOutputs(dir, []string{"isolated-secret-never-in-artifact"}, a); err != nil {
			t.Fatalf("clean Worker artifact rejected: %v", err)
		}
		after, _ := os.ReadFile(filepath.Join(dir, "output/author.json"))
		if !bytes.Equal(data, after) {
			t.Fatal("clean Module bytes rewritten")
		}
	}
}

func TestModuleCredentialSecretsDuplicatesAndInvalidRemainRejected(t *testing.T) {
	a := platformAuthorFixture(t, "module-authoring")
	cases := map[string][]byte{
		"plain":                   []byte(`{"message":"synthetic secret"}`),
		"json-escape":             []byte(`{"message":"synthetic\u0020secret"}`),
		"query-escape":            []byte(`{"message":"synthetic+secret"}`),
		"path-escape":             []byte(`{"message":"synthetic%20secret"}`),
		"duplicate-hidden-secret": []byte(`{"message":"synthetic secret","message":"clean"}`),
		"duplicate-clean":         []byte(`{"message":"clean","message":"clean"}`),
		"nested-duplicate":        []byte(`{"module":{"slug":"a","slug":"b"}}`),
		"escaped-duplicate-key":   []byte(`{"message":"clean","\u006dessage":"clean"}`),
		"secret-key":              []byte(`{"synthetic secret":"clean"}`),
		"invalid":                 []byte(`{"message":`), "trailing": []byte(`{} {}`), "non-object": []byte(`[]`), "invalid-utf8": []byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'},
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			os.Mkdir(filepath.Join(dir, "output"), 0700)
			path := filepath.Join(dir, "output/author.json")
			os.WriteFile(path, data, 0600)
			if sanitizeCredentialOutputs(dir, []string{"synthetic secret"}, a) == nil {
				t.Fatal("unsafe Module certified")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(data, after) {
				t.Fatal("rejected Module rewritten")
			}
		})
	}
	t.Run("oversize", func(t *testing.T) {
		dir := t.TempDir()
		os.Mkdir(filepath.Join(dir, "output"), 0700)
		data := []byte(`{"message":"` + strings.Repeat("x", 25<<20) + `"}`)
		path := filepath.Join(dir, "output/author.json")
		os.WriteFile(path, data, 0600)
		if sanitizeCredentialOutputs(dir, []string{"synthetic secret"}, a) == nil {
			t.Fatal("oversize certified")
		}
	})
	t.Run("ordinary-report-still-redacted", func(t *testing.T) {
		dir := t.TempDir()
		os.Mkdir(filepath.Join(dir, "output"), 0700)
		path := filepath.Join(dir, "output/results.json")
		os.WriteFile(path, []byte(`{"message":"synthetic secret","stats":{"expected":1}}`), 0600)
		if err := sanitizeCredentialOutputs(dir, []string{"synthetic secret"}); err != nil {
			t.Fatal(err)
		}
		raw, _ := os.ReadFile(path)
		var got map[string]any
		if json.Unmarshal(raw, &got) != nil || got["message"] != "[redacted]" || got["stats"].(map[string]any)["expected"] != float64(1) {
			t.Fatal("ordinary report semantics changed")
		}
	})
}

// Exercise the production Manager lifecycle; only container execution and HTTP
// transport are substitutes. Artifact bytes come from the real Worker serializer.
type credentialModuleRuntime struct {
	t        *testing.T
	manager  *Manager
	original []byte
}

func (*credentialModuleRuntime) Remove(context.Context, record) error { return nil }
func (d *credentialModuleRuntime) Execute(_ context.Context, r record, dir string, _ func(string, string)) execution {
	os.MkdirAll(filepath.Join(dir, "output"), 0700)
	d.original = nodeModuleArtifact(d.t, dir)
	if err := atomicJSON(filepath.Join(dir, "output/result.json"), Result{Status: "succeeded"}); err != nil {
		d.t.Fatal(err)
	}
	if err := d.manager.rememberCredentials(r, credentialValues{Username: "isolated-username", Password: "isolated-secret-never-in-artifact"}); err != nil {
		d.t.Fatal(err)
	}
	return execution{ExitCode: 0}
}
func TestModuleCredentialLifecycleCollectParseUpload(t *testing.T) {
	t.Setenv("WHIPPET_M109_DIAGNOSTICS", "1")
	m, _, ctx := lifecycleManager(t, 1)
	driver := &credentialModuleRuntime{t: t, manager: m}
	m.docker = driver
	uploaded := false
	m.http.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/artifacts/author.json") {
			body, err := io.ReadAll(req.Body)
			if err != nil || !bytes.Equal(body, driver.original) {
				t.Fatal("uploaded Module bytes changed")
			}
			uploaded = true
		}
		return &http.Response{StatusCode: 201, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	a := platformAuthorFixture(t, "module-authoring")
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "accepted", TimeoutMS: 180000, ResultMessageID: newID(), Author: a}
	if err := m.store(r); err != nil {
		t.Fatal(err)
	}
	dispatch := authorDispatch()
	dispatch.Author = a
	m.runAttempt(ctx, ctx, r, &dispatch)
	saved := journalRecord(m, r.AttemptID)
	if saved.Result == nil || saved.Result.Status != "succeeded" || saved.Phase != "complete" || !saved.Reclaimed || !saved.CredentialsUsed || !saved.CredentialsSanitized || !uploaded {
		t.Fatal("successful credential lifecycle rejected")
	}
	raw, err := os.ReadFile(filepath.Join(m.cfg.WorkDir, "diagnostics", r.AttemptID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var got m109Diagnostic
	if json.Unmarshal(raw, &got) != nil || !got.Manager.AuthorParserAccepted || !got.Manager.UploadAttempted || !got.Manager.UploadAccepted || got.Manager.Disposition != "ACCEPTED" {
		t.Fatal("collect/parser/upload did not complete")
	}
}
