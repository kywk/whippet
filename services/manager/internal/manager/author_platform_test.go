package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func platformAuthorFixture(t *testing.T, skill string) *AuthorTask {
	a := v10Author(t)
	a.SkillID = &skill
	a.Skills = json.RawMessage(strings.ReplaceAll(string(a.Skills), "test-author", skill))
	tools := []string{"update_module_candidate", "request_module_validation"}
	if skill == "usecase-planner" {
		tools = []string{"propose_plan"}
	}
	a.AllowedTools = &tools
	module := moduleFixture()
	if skill == "usecase-planner" {
		module = nil
	}
	a.Platform, _ = json.Marshal(map[string]any{"planId": nil, "stageId": nil, "module": module})
	return a
}
func moduleFixture() map[string]any {
	return map[string]any{"slug": "search", "moduleKind": "step", "exportName": "search", "signature": "", "inputs": "", "returns": "", "preconditions": "", "postconditions": "", "harness": "import {test} from '@playwright/test'; test('ok',()=>{});"}
}
func TestM106NestedPlatformAndFinalParser(t *testing.T) {
	a := platformAuthorFixture(t, "module-authoring")
	script := "export function search(){return 1}"
	if !validPlatform(a.Platform, a, script) || validAuthorMetadata(a, &script) != nil {
		t.Fatal("valid module rejected")
	}
	for _, raw := range []json.RawMessage{nil, []byte("null"), []byte(`{"planId":null,"stageId":"stage","module":null}`)} {
		if validPlatform(raw, a, script) {
			t.Fatal("bad platform accepted")
		}
	}
	d := m7Dispatch(t, false)
	d.Author = a
	d.Script = script
	raw, _ := json.Marshal(d)
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	fields["platform"] = a.Platform
	raw, _ = json.Marshal(fields)
	var parsed Dispatch
	if json.Unmarshal(raw, &parsed) == nil {
		t.Fatal("duplicate top-level accepted")
	}
	ordinary := v10Author(t)
	ordinary.Platform = a.Platform
	if validAuthorMetadata(ordinary, &script) == nil {
		t.Fatal("ordinary platform accepted")
	}
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "output"), 0700)
	out := map[string]any{"message": "ok", "script": script, "module": moduleFixture(), "requestValidation": false}
	writePartial(t, dir, out)
	if !validAuthorArtifact(dir, a, nil) {
		t.Fatal("module final rejected")
	}
	for _, key := range []string{"partial", "planCandidate", "unknown"} {
		out[key] = map[string]any{}
		writePartial(t, dir, out)
		if validAuthorArtifact(dir, a, nil) {
			t.Fatal("module accepted " + key)
		}
		delete(out, key)
	}
	planner := platformAuthorFixture(t, "usecase-planner")
	out = map[string]any{"message": "ok", "planCandidate": map[string]any{"candidateRef": newID()}}
	writePartial(t, dir, out)
	if !validAuthorArtifact(dir, planner, nil) {
		t.Fatal("planner rejected")
	}
	out["requestValidation"] = false
	writePartial(t, dir, out)
	if validAuthorArtifact(dir, planner, nil) {
		t.Fatal("planner accepted validation")
	}
}
func TestM106ModuleArtifact25MiBReadOpenUpload(t *testing.T) {
	a := platformAuthorFixture(t, "module-authoring")
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "output"), 0700)
	module := moduleFixture()
	module["harness"] = strings.Repeat("\x01", maxScriptBytes)
	out := map[string]any{"message": "ok", "script": strings.Repeat("\x01", maxScriptBytes), "module": module, "requestValidation": false}
	raw, _ := json.Marshal(out)
	if len(raw) <= maxAuthorArtifactBytes {
		t.Fatal("escaping fixture too small")
	}
	_ = os.WriteFile(filepath.Join(dir, "output/author.json"), raw, 0600)
	if !validAuthorArtifact(dir, a, nil) || validAuthorArtifact(dir, v10Author(t), nil) {
		t.Fatal("primary size/parser selection")
	}
	var parsed json.RawMessage
	if readOutput(dir, "author.json", &parsed, a) != nil {
		t.Fatal("module read rejected")
	}
	if f, e := openArtifact(dir, "author.json"); e == nil {
		f.Close()
		t.Fatal("default limit widened")
	}
	limit := int(authorArtifactLimit(a))
	padded := append(append([]byte(nil), raw...), bytes.Repeat([]byte(" "), limit-len(raw))...)
	_ = os.WriteFile(filepath.Join(dir, "output/author.json"), padded, 0600)
	if !validAuthorArtifact(dir, a, nil) {
		t.Fatal("exact boundary rejected")
	}
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Author: a}
	m := &Manager{cfg: Config{WorkDir: t.TempDir(), ServerURL: "https://synthetic.invalid"}}
	_ = os.MkdirAll(filepath.Join(m.taskDir(r), "output"), 0700)
	_ = os.WriteFile(filepath.Join(m.taskDir(r), "output/author.json"), padded, 0600)
	uploads := 0
	m.http = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		n, _ := io.Copy(io.Discard, req.Body)
		if n != int64(limit) {
			t.Fatal("wrong upload size")
		}
		uploads++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
	})}
	if m.upload(context.Background(), r, "author.json") != nil || uploads != 1 {
		t.Fatal("upload failed")
	}
	_ = os.WriteFile(filepath.Join(m.taskDir(r), "output/author.json"), append(padded, ' '), 0600)
	if m.upload(context.Background(), r, "author.json") == nil || uploads != 1 {
		t.Fatal("overflow uploaded")
	}
	_ = os.WriteFile(filepath.Join(dir, "output/author.json"), append(padded, ' '), 0600)
	if readOutput(dir, "author.json", &parsed, a) == nil || validAuthorArtifact(dir, a, nil) {
		t.Fatal("overflow read/parser accepted")
	}
}
func TestM106RegistrySchemaGuards(t *testing.T) {
	registry, e := loadToolRegistry()
	if e != nil {
		t.Fatal(e)
	}
	get := func(name string) registryTool {
		for _, tool := range registry.Tools {
			if tool.Name == name {
				return tool
			}
		}
		t.Fatal(name)
		return registryTool{}
	}
	for _, raw := range []string{`{"query":"ok","limit":0,"cursor":null}`, `{"query":"ok","limit":1.5,"cursor":null}`, `{"query":"ok","limit":1,"cursor":null,"extra":1}`, `{"query":"` + strings.Repeat("中", 342) + `","limit":1,"cursor":null}`} {
		if validToolArguments(get("catalog_search"), []byte(raw)) {
			t.Fatal("invalid search accepted")
		}
	}
	if !validToolArguments(get("catalog_search"), []byte(`{"query":"ok","limit":20,"cursor":null}`)) {
		t.Fatal("valid search rejected")
	}
	for _, args := range []string{`{"page":{"kind":"literal","value":1}}`, `{"x":{"kind":"literal","value":{"__proto__":1}}}`, `{"x":{"kind":"binding","stageId":"a","path":[1]}}`} {
		raw := `{"stages":[{"id":"a","title":"A","action":"reuse","moduleVersionId":"` + newID() + `","args":` + args + `}]}`
		if validToolArguments(get("propose_plan"), []byte(raw)) {
			t.Fatal("invalid plan accepted")
		}
	}
	if _, e := parseToolSchema([]byte(`{"type":"object","unsupported":true}`)); e == nil {
		t.Fatal("unsupported schema accepted")
	}
}

func TestM106ModuleRedactionInvalidatesCandidate(t *testing.T) {
	a := platformAuthorFixture(t, "module-authoring")
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "output"), 0700)
	out := map[string]any{"message": "ok", "script": "export function search(){return 'synthetic-password'}", "module": moduleFixture(), "requestValidation": false}
	writePartial(t, dir, out)
	if sanitizeCredentialOutputs(dir, []string{"synthetic-password"}, a) == nil {
		t.Fatal("rewritten candidate still certified")
	}
}
func TestM106GenericCatalogRoutingAndPerToolFrameLimit(t *testing.T) {
	a := platformAuthorFixture(t, "usecase-planner")
	names := []string{"catalog_get", "read_plan"}
	a.AllowedTools = &names
	r := record{RunID: newID(), AttemptID: newID(), Author: a, TimeoutMS: 180000}
	sink := &frameSink{frames: make(chan []byte, 3)}
	count := 0
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		count++
		var q struct {
			CallID string `json:"callId"`
		}
		_ = json.NewDecoder(req.Body).Decode(&q)
		raw, _ := json.Marshal(map[string]any{"runId": r.RunID, "attemptId": r.AttemptID, "callId": q.CallID, "result": map[string]string{"script": strings.Repeat("x", 14<<20)}})
		return &http.Response{StatusCode: 200, Header: http.Header{"Cache-Control": []string{"no-store"}}, Body: io.NopCloser(bytes.NewReader(raw))}, nil
	})}
	c := &toolChannel{ctx: context.Background(), cfg: Config{ServerURL: "https://synthetic.invalid"}, r: r, input: sink, client: client}
	q := toolRequest{Kind: "tool_request", RequestID: newID(), AttemptID: r.AttemptID, Name: "catalog_get", Arguments: json.RawMessage(`{"moduleVersionId":"` + newID() + `"}`)}
	c.handle(encodeTool(t, q))
	if out := nextToolReply(t, sink); out.Error != "" || len(out.Result) <= toolFrameLimit {
		t.Fatal("large catalog reply rejected")
	}
	q.RequestID = newID()
	q.Name = "read_plan"
	q.Arguments = json.RawMessage(`{}`)
	c.handle(encodeTool(t, q))
	if out := nextToolReply(t, sink); out.Error == "" {
		t.Fatal("read_plan accepted module-sized reply")
	}
	if count != 2 {
		t.Fatal("wrong request count")
	}
}
