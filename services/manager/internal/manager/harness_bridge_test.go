package manager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func actualSkillPin(t *testing.T, a *AuthorTask) {
	t.Helper()
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(source), "../../../../runtimes/worker/skills", *a.SkillID)
	raw, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	main, err := os.ReadFile(filepath.Join(root, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Budget     json.RawMessage `json:"budget"`
		Model      json.RawMessage `json:"model"`
		References []struct {
			ID     string `json:"id"`
			SHA256 string `json:"sha256"`
		} `json:"references"`
	}
	if json.Unmarshal(raw, &manifest) != nil {
		t.Fatal("invalid manifest")
	}
	refs := map[string]string{}
	for _, ref := range manifest.References {
		refs[ref.ID] = ref.SHA256
	}
	a.Skills, _ = json.Marshal([]skillPin{{ID: *a.SkillID, Version: *a.SkillVersion, SHA256: fmt.Sprintf("%x", sha256.Sum256(main)), ManifestSHA256: fmt.Sprintf("%x", sha256.Sum256(raw)), ReferenceHashes: refs}})
	a.Budget = manifest.Budget
	a.Model = manifest.Model
}
func runHarnessAuthorBridge(t *testing.T, input WorkerInput, url, token string, client *http.Client, partial bool) {
	t.Helper()
	var models, success, failure, transports atomic.Int32
	platform := moduleAuthor(input.Author) || plannerAuthor(input.Author)
	batchSummary := summaryAuthor(input.Author) && len(input.Author.Batch) > 0
	moduleSummary := summaryAuthor(input.Author) && len(input.Author.ModuleSummary) > 0
	summarySnapshot := batchSummary || moduleSummary
	var batchPromptChecked atomic.Bool
	var platformCalls []struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	expectedTools, expectedIPC := int32(1), int32(1)
	if summarySnapshot {
		if !validAuthorBatch(input.Author) || !validModuleSummary(input.Author, &input.Script) {
			t.Fatal("invalid batch fixture")
		}
		expectedTools = 0
		expectedIPC = 0
	}
	if platform {
		callsPath := os.Getenv("WHIPPET_M106_BRIDGE_CALLS")
		if !filepath.IsAbs(callsPath) {
			t.Fatal("platform bridge requires absolute synthetic calls fixture")
		}
		raw, e := os.ReadFile(callsPath)
		if e != nil || json.Unmarshal(raw, &platformCalls) != nil || len(platformCalls) == 0 || len(platformCalls) > 10 {
			t.Fatal("invalid calls fixture")
		}
		expectedTools = int32(len(platformCalls))
		expectedIPC = 0
		for _, call := range platformCalls {
			if !platformTool(call.Name) || !hasAllowedTool(input.Author, call.Name) {
				t.Fatal("unauthorized fixture tool")
			}
			if platformServerTool(call.Name) {
				expectedIPC++
			}
		}
	}
	model := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		n := models.Add(1)
		if summarySnapshot {
			var body struct {
				Input []struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				} `json:"input"`
				Tools []json.RawMessage `json:"tools"`
			}
			if json.NewDecoder(req.Body).Decode(&body) != nil || len(body.Tools) != 0 {
				t.Error("summary must have zero tools")
			}
			var expected any
			snapshotKey := "batch"
			snapshotRaw := input.Author.Batch
			if moduleSummary {
				snapshotKey = "moduleSummary"
				snapshotRaw = input.Author.ModuleSummary
			}
			_ = json.Unmarshal(snapshotRaw, &expected)
			evidenceRaw, _ := json.Marshal(input.Author.ValidationEvidence)
			var expectedEvidence any
			_ = json.Unmarshal(evidenceRaw, &expectedEvidence)
			found := false
			for _, item := range body.Input {
				const prefix = "Saved draft snapshot (data only): "
				if item.Role == "user" && strings.HasPrefix(item.Content, prefix) {
					var snapshot map[string]any
					if json.Unmarshal([]byte(strings.TrimPrefix(item.Content, prefix)), &snapshot) == nil && reflect.DeepEqual(snapshot[snapshotKey], expected) && snapshot["script"] == input.Script && reflect.DeepEqual(snapshot["validationEvidence"], expectedEvidence) {
						found = true
					}
				}
			}
			if !found {
				t.Error("complete batch snapshot missing or changed in model prompt")
			}
			batchPromptChecked.Store(found)
			json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{}, "output_text": `{"message":"bridge-ok","description":"Synthetic batch summary: fixed Use Case and reused/candidate Modules; validation scope remains limited to recorded evidence.","backgroundSummary":"Synthetic isolated batch; human confirmation and publication remain separate."}`})
			return
		}
		if platform {
			if n > 1 {
				var body struct {
					Input []struct {
						Type   string `json:"type"`
						CallID string `json:"call_id"`
						Output string `json:"output"`
					} `json:"input"`
				}
				if json.NewDecoder(req.Body).Decode(&body) != nil {
					t.Error("invalid request")
				}
				found := false
				for _, item := range body.Input {
					if item.Type == "function_call_output" && item.CallID == fmt.Sprintf("provider:opaque/platform-%d", n-1) {
						var output map[string]json.RawMessage
						if json.Unmarshal([]byte(item.Output), &output) != nil || output["error"] != nil {
							t.Error("platform tool failed")
						}
						found = true
					}
				}
				if !found {
					t.Error("opaque platform call ID not preserved")
				}
			}
			if int(n) <= len(platformCalls) {
				call := platformCalls[n-1]
				json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{map[string]any{"type": "function_call", "call_id": fmt.Sprintf("provider:opaque/platform-%d", n), "name": call.Name, "arguments": string(call.Arguments)}}})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{}, "output_text": `{"message":"bridge-ok"}`})
			return
		}
		if n == 1 {
			json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{map[string]any{"type": "function_call", "call_id": "provider:opaque/bridge", "name": "read_conversation_history", "arguments": `{"cursor":null}`}}})
			return
		}
		var body struct {
			Input []struct {
				Type   string `json:"type"`
				CallID string `json:"call_id"`
				Output string `json:"output"`
			} `json:"input"`
		}
		if json.NewDecoder(req.Body).Decode(&body) != nil {
			t.Error("invalid provider request")
		}
		found := false
		for _, item := range body.Input {
			if item.Type == "function_call_output" {
				var result struct {
					Items []json.RawMessage `json:"items"`
				}
				_ = json.Unmarshal([]byte(item.Output), &result)
				found = item.CallID == "provider:opaque/bridge" && len(result.Items) > 0
			}
		}
		if !found {
			t.Error("history or original opaque call ID missing")
		}
		json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{}, "output_text": `{"message":"bridge-ok"}`})
	}))
	defer model.Close()
	root := t.TempDir()
	work := filepath.Join(root, "runs", input.AttemptID)
	if err := os.MkdirAll(work, 0700); err != nil {
		t.Fatal(err)
	}
	cert := filepath.Join(root, "synthetic-provider-ca.pem")
	if err := os.WriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: model.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(input)
	if err := os.WriteFile(filepath.Join(work, "input.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	entry := os.Getenv("WHIPPET_M10_WORKER_ENTRY")
	if entry == "" {
		_, source, _, _ := runtime.Caller(0)
		entry = filepath.Join(filepath.Dir(source), "../../../../runtimes/worker/dist/author/main.js")
	}
	var configured skillModel
	if json.Unmarshal(input.Author.Model, &configured) != nil {
		t.Fatal("missing model pin")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", entry)
	// Only benign environment needed by Node; real provider/manager credentials never inherited.
	for _, name := range []string{"PATH", "HOME", "TMPDIR", "LANG", "WHIPPET_TOOL_REGISTRY_PATH", "WHIPPET_SKILLS_PATH"} {
		if value := os.Getenv(name); value != "" {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "WHIPPET_WORK_DIR="+work, "NODE_EXTRA_CA_CERTS="+cert, "WHIPPET_AI_ENABLED=true", "WHIPPET_AI_BASE_URL="+model.URL, "WHIPPET_AI_MODEL="+configured.Model, "WHIPPET_AI_REASONING_EFFORT="+configured.ReasoningEffort, "OPENCODE_API_KEY=synthetic-provider-token")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	writer := &attemptInputWriter{ctx: ctx, input: stdin}
	defer writer.close()
	r := record{RunID: input.RunID, AttemptID: input.AttemptID, Kind: "author", TimeoutMS: input.TimeoutMS, Author: input.Author, WorkspaceID: input.WorkspaceID, TestID: input.TestID, WorkspaceContext: input.WorkspaceContext}
	channel := &toolChannel{ctx: ctx, cfg: Config{ServerURL: url, Token: token}, r: r, input: writer, client: client}
	cmd.Stdout = &lineWriter{toolFrames: true, intercept: func(line string) bool {
		var frame toolRequest
		if json.Unmarshal([]byte(line), &frame) == nil && frame.Kind == "tool_request" {
			transports.Add(1)
			if !uuidPattern.MatchString(frame.RequestID) {
				t.Error("transport ID not UUID")
			}
		}
		return channel.handle(line)
	}, emit: func(_ string, text string) {
		if strings.HasSuffix(text, ":read_conversation_history:succeeded") || platform && strings.HasPrefix(text, "author:tool:") && strings.HasSuffix(text, ":succeeded") {
			success.Add(1)
		}
		if strings.HasSuffix(text, ":read_conversation_history:failed") || platform && strings.HasPrefix(text, "author:tool:") && strings.HasSuffix(text, ":failed") {
			failure.Add(1)
		}
	}}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		safeCode := "unavailable"
		if raw, readErr := os.ReadFile(filepath.Join(work, "output/result.json")); readErr == nil {
			var result Result
			if json.Unmarshal(raw, &result) == nil {
				for _, code := range []string{"invalid_input", "limit", "tool_failed", "provider_failed", "invalid_response", "sensitive_output", "timed_out", "cancelled", "skill_unavailable", "security_unavailable"} {
					if result.Error == "Author task "+code+"; provider and browser details are hidden" {
						safeCode = code
					}
				}
			}
		}
		t.Fatalf("author process failed (%v), safeCode=%s stderrBytes=%d modelRequests=%d toolsSuccess=%d toolsFailure=%d", err, safeCode, stderr.Len(), models.Load(), success.Load(), failure.Load())
	}
	out, err := os.ReadFile(filepath.Join(work, "output/author.json"))
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(out, &answer) != nil || (!partial && answer.Message != "bridge-ok") {
		t.Fatal("author answer mismatch")
	}
	result, err := os.ReadFile(filepath.Join(work, "output/result.json"))
	if err != nil {
		t.Fatal(err)
	}
	var terminal Result
	if json.Unmarshal(result, &terminal) != nil || terminal.Status != "succeeded" {
		t.Fatal("author terminal not succeeded")
	}
	expectedModels := int32(2)
	if summarySnapshot {
		expectedModels = 1
		if !batchPromptChecked.Load() {
			t.Fatal("batch prompt was not checked")
		}
	}
	if platform {
		expectedModels = int32(len(platformCalls) + 1)
	}
	if partial {
		expectedModels = 1
		var value struct {
			Script            *string `json:"script"`
			RequestValidation bool    `json:"requestValidation"`
			Partial           struct {
				Reason     string          `json:"reason"`
				Checkpoint json.RawMessage `json:"checkpoint"`
			} `json:"partial"`
		}
		if json.Unmarshal(out, &value) != nil || value.Partial.Reason != "budget_exhausted" || value.Script != nil || value.RequestValidation || len(value.Partial.Checkpoint) > 0 {
			t.Fatal("invalid no-checkpoint partial output")
		}
	}
	if partial || platform || summarySnapshot {
		result, names := collectAttemptResult(r, work, execution{ExitCode: 0})
		if result.Status != "succeeded" || len(names) != 1 || names[0] != "author.json" {
			t.Fatal("Manager rejected partial artifact")
		}
		manager := &Manager{cfg: Config{ServerURL: url, Token: token, WorkDir: root}, http: client}
		if err := manager.upload(ctx, r, "author.json"); err != nil {
			t.Fatal("partial upload failed", err)
		}
		handoff := os.Getenv("WHIPPET_M10_BRIDGE_RESULT")
		if !filepath.IsAbs(handoff) {
			t.Fatal("partial bridge requires absolute result handoff")
		}
		raw, _ := json.Marshal(map[string]any{"runId": r.RunID, "attemptId": r.AttemptID, "result": result, "artifactUploaded": true, "partial": partial, "checkpoint": false, "batchPromptChecked": batchSummary && batchPromptChecked.Load(), "moduleSummaryPromptChecked": moduleSummary && batchPromptChecked.Load()})
		if err := os.WriteFile(handoff, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if models.Load() != expectedModels || transports.Load() != expectedIPC || success.Load() != expectedTools || failure.Load() != 0 {
		t.Fatal("unexpected bridge call counts")
	}
	t.Logf("modelRequests=%d genericIPC=%d toolSuccess=%d toolFailure=%d", models.Load(), transports.Load(), success.Load(), failure.Load())
}
func TestM10HarnessRealAuthorIPC(t *testing.T) {
	if os.Getenv("WHIPPET_M10_WORKER_ENTRY") == "" {
		t.Skip("opt in with compiled Worker entry")
	}
	r, _, page := harnessFixture(t)
	actualSkillPin(t, r.Author)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/manager/runs/"+r.RunID+"/attempts/"+r.AttemptID+"/tools" {
			t.Error("wrong path")
			w.WriteHeader(404)
			return
		}
		var q struct {
			CallID string `json:"callId"`
			Name   string `json:"name"`
		}
		if json.NewDecoder(req.Body).Decode(&q) != nil || !uuidPattern.MatchString(q.CallID) || q.Name != "read_conversation_history" {
			t.Error("bad generic request")
		}
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"runId": r.RunID, "attemptId": r.AttemptID, "callId": q.CallID, "result": page})
	}))
	defer server.Close()
	input := WorkerInput{Kind: "author", RunID: r.RunID, AttemptID: r.AttemptID, TimeoutMS: 180000, Script: "saved draft", Author: r.Author, WorkspaceID: r.WorkspaceID, TestID: r.TestID, WorkspaceContext: r.WorkspaceContext}
	runHarnessAuthorBridge(t, input, server.URL, "synthetic-manager-token", server.Client(), false)
}
func externalHarnessBridge(t *testing.T, partial bool) {
	url := os.Getenv("WHIPPET_M10_BRIDGE_URL")
	if url == "" {
		t.Skip("requires isolated Server TLS fixture")
	}
	token := os.Getenv("WHIPPET_M10_BRIDGE_TOKEN")
	if !strings.HasPrefix(token, "synthetic-") {
		t.Fatal("bridge only accepts synthetic fixture credentials")
	}
	raw, err := os.ReadFile(os.Getenv("WHIPPET_M10_BRIDGE_INPUT"))
	if err != nil {
		t.Fatal(err)
	}
	var input WorkerInput
	if json.Unmarshal(raw, &input) != nil || input.Author == nil {
		t.Fatal("invalid bridge WorkerInput")
	}
	ca, err := os.ReadFile(os.Getenv("WHIPPET_M10_BRIDGE_CA"))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		t.Fatal("invalid synthetic CA")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	defer transport.CloseIdleConnections()
	if partial {
		var budget skillBudget
		if json.Unmarshal(input.Author.Budget, &budget) != nil || budget.MaxModelRequests != 1 || budget.MaxToolCalls < 1 {
			t.Fatal("partial fixture must pin one model request")
		}
	}
	runHarnessAuthorBridge(t, input, url, token, &http.Client{Transport: transport, Timeout: 15 * time.Second}, partial)
}

func TestM10HarnessServerBridge(t *testing.T)       { externalHarnessBridge(t, false) }
func TestM10PartialServerBridge(t *testing.T)       { externalHarnessBridge(t, true) }
func TestM106PlatformServerBridge(t *testing.T)     { externalHarnessBridge(t, false) }
func TestM105BatchSummaryServerBridge(t *testing.T) { externalHarnessBridge(t, false) }
func TestM10ModuleSummaryServerBridge(t *testing.T) { externalHarnessBridge(t, false) }

func TestM10PartialRealAuthorIPC(t *testing.T) {
	if os.Getenv("WHIPPET_M10_WORKER_ENTRY") == "" {
		t.Skip("opt in with compiled Worker entry")
	}
	r, _, page := harnessFixture(t)
	actualSkillPin(t, r.Author)
	var budget skillBudget
	_ = json.Unmarshal(r.Author.Budget, &budget)
	budget.MaxModelRequests = 1
	r.Author.Budget, _ = json.Marshal(budget)
	var uploads atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if strings.HasSuffix(req.URL.Path, "/artifacts/author.json") {
			var out struct {
				Partial struct {
					Reason string `json:"reason"`
				} `json:"partial"`
			}
			if json.NewDecoder(req.Body).Decode(&out) != nil || out.Partial.Reason != "budget_exhausted" {
				t.Error("uploaded wrong author artifact")
			}
			uploads.Add(1)
			w.WriteHeader(200)
			return
		}
		var q struct {
			CallID string `json:"callId"`
		}
		if json.NewDecoder(req.Body).Decode(&q) != nil {
			t.Error("bad generic body")
		}
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"runId": r.RunID, "attemptId": r.AttemptID, "callId": q.CallID, "result": page})
	}))
	defer server.Close()
	handoff := filepath.Join(t.TempDir(), "result.json")
	t.Setenv("WHIPPET_M10_BRIDGE_RESULT", handoff)
	input := WorkerInput{Kind: "author", RunID: r.RunID, AttemptID: r.AttemptID, TimeoutMS: 180000, Script: "saved draft", Author: r.Author, WorkspaceID: r.WorkspaceID, TestID: r.TestID, WorkspaceContext: r.WorkspaceContext}
	runHarnessAuthorBridge(t, input, server.URL, "synthetic-manager-token", server.Client(), true)
	raw, err := os.ReadFile(handoff)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		ArtifactUploaded bool   `json:"artifactUploaded"`
		Partial          bool   `json:"partial"`
		Result           Result `json:"result"`
	}
	if json.Unmarshal(raw, &result) != nil || !result.ArtifactUploaded || !result.Partial || result.Result.Status != "succeeded" || uploads.Load() != 1 {
		t.Fatal("invalid partial handoff")
	}
}

func TestM106PlannerRealAuthorIPC(t *testing.T) {
	if os.Getenv("WHIPPET_M10_WORKER_ENTRY") == "" {
		t.Skip("opt in with compiled Worker entry")
	}
	a := platformAuthorFixture(t, "usecase-planner")
	actualSkillPin(t, a)
	names := []string{"catalog_search", "catalog_get", "propose_plan"}
	a.AllowedTools = &names
	version := newID()
	stages := []any{map[string]any{"id": "first", "title": "reuse", "action": "reuse", "moduleVersionId": version, "args": map[string]any{}}}
	calls := []any{map[string]any{"name": "catalog_search", "arguments": map[string]any{"query": "search", "limit": 1}}, map[string]any{"name": "catalog_get", "arguments": map[string]any{"moduleVersionId": version}}, map[string]any{"name": "propose_plan", "arguments": map[string]any{"stages": stages}}}
	path := filepath.Join(t.TempDir(), "calls.json")
	raw, _ := json.Marshal(calls)
	_ = os.WriteFile(path, raw, 0600)
	t.Setenv("WHIPPET_M106_BRIDGE_CALLS", path)
	t.Setenv("WHIPPET_M10_BRIDGE_RESULT", filepath.Join(t.TempDir(), "result.json"))
	input := WorkerInput{Kind: "author", RunID: newID(), AttemptID: newID(), Script: "", TimeoutMS: 180000, Author: a}
	var uploads atomic.Int32
	ref := newID()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if strings.HasSuffix(req.URL.Path, "/artifacts/author.json") {
			var out struct {
				Candidate struct {
					Ref string `json:"candidateRef"`
				} `json:"planCandidate"`
			}
			if json.NewDecoder(req.Body).Decode(&out) != nil || out.Candidate.Ref != ref {
				t.Error("wrong guard candidate")
			}
			uploads.Add(1)
			w.WriteHeader(204)
			return
		}
		var q struct {
			CallID string `json:"callId"`
			Name   string `json:"name"`
		}
		_ = json.NewDecoder(req.Body).Decode(&q)
		var result any
		switch q.Name {
		case "catalog_search":
			result = map[string]any{"items": []any{map[string]any{"testId": newID(), "versionId": version, "name": "search", "module": moduleFixture()}}, "nextCursor": nil}
		case "catalog_get":
			result = map[string]any{"testId": newID(), "versionId": version, "script": "export function search(){return 1}", "module": moduleFixture(), "scriptOrigin": "manual"}
		case "propose_plan":
			result = map[string]any{"candidate": true, "candidateRef": ref, "stages": stages}
		default:
			t.Error("unexpected tool")
		}
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"runId": input.RunID, "attemptId": input.AttemptID, "callId": q.CallID, "result": result})
	}))
	defer server.Close()
	runHarnessAuthorBridge(t, input, server.URL, "synthetic-platform-token", server.Client(), false)
	if uploads.Load() != 1 {
		t.Fatal("expected one artifact upload")
	}
}

func TestM105BatchSummaryRealAuthorIPC(t *testing.T) {
	if os.Getenv("WHIPPET_M10_WORKER_ENTRY") == "" {
		t.Skip("opt in with compiled Worker entry")
	}
	d := m7Dispatch(t, true)
	a := d.Author
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	a.ToolRegistryVersion = &registry.Version
	a.ToolRegistrySHA256 = &registry.SHA256
	actualSkillPin(t, a)
	testID := newID()
	testRaw, _ := json.Marshal(testID)
	metadata := moduleFixture()
	delete(metadata, "harness")
	a.Batch, _ = json.Marshal(map[string]any{"schemaVersion": 1, "planId": newID(), "planRevision": 1, "batchHash": strings.Repeat("a", 64), "usecase": map[string]any{"testId": testID, "editingSessionId": *a.EditingSessionID, "revision": a.BaseRevision, "contextRevision": *a.ContextRevision, "bundleHash": strings.Repeat("b", 64), "validationEvidence": a.ValidationEvidence}, "modules": []any{map[string]any{"testId": newID(), "versionId": newID(), "mode": "reuse", "editingSessionId": nil, "revision": a.BaseRevision, "contextRevision": 0, "bundleHash": strings.Repeat("b", 64), "name": "Synthetic reusable module", "description": nil, "module": metadata, "harnessHash": strings.Repeat("c", 64), "validationEvidence": a.ValidationEvidence}}})
	input := WorkerInput{Kind: "author", RunID: newID(), AttemptID: newID(), Script: d.Script, TimeoutMS: 180000, Author: a, WorkspaceID: newID(), TestID: testRaw}
	handoff := filepath.Join(t.TempDir(), "handoff.json")
	t.Setenv("WHIPPET_M10_BRIDGE_RESULT", handoff)
	var uploads atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/manager/runs/"+input.RunID+"/artifacts/author.json" {
			t.Error("summary attempted a tool or wrong upload path")
			w.WriteHeader(404)
			return
		}
		var output map[string]json.RawMessage
		if json.NewDecoder(req.Body).Decode(&output) != nil || len(output) != 3 || output["message"] == nil || output["description"] == nil || output["backgroundSummary"] == nil {
			t.Error("summary final shape changed")
		}
		uploads.Add(1)
		w.WriteHeader(204)
	}))
	defer server.Close()
	runHarnessAuthorBridge(t, input, server.URL, "synthetic-summary-token", server.Client(), false)
	var summary struct {
		Checked bool `json:"batchPromptChecked"`
	}
	raw, err := os.ReadFile(handoff)
	if err != nil || json.Unmarshal(raw, &summary) != nil || !summary.Checked || uploads.Load() != 1 {
		t.Fatal("summary handoff/upload not verified")
	}
}

func TestM10ModuleSummaryRealAuthorIPC(t *testing.T) {
	if os.Getenv("WHIPPET_M10_WORKER_ENTRY") == "" {
		t.Skip("opt in with compiled Worker entry")
	}
	d := moduleSummaryFixture(t)
	testRaw, _ := json.Marshal(newID())
	input := WorkerInput{Kind: "author", RunID: newID(), AttemptID: newID(), Script: d.Script, TimeoutMS: 180000, Author: d.Author, WorkspaceID: newID(), TestID: testRaw}
	handoff := filepath.Join(t.TempDir(), "handoff.json")
	t.Setenv("WHIPPET_M10_BRIDGE_RESULT", handoff)
	var uploads atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/manager/runs/"+input.RunID+"/artifacts/author.json" {
			t.Error("unexpected tool/path")
			w.WriteHeader(404)
			return
		}
		var out map[string]json.RawMessage
		if json.NewDecoder(req.Body).Decode(&out) != nil || len(out) != 3 || out["description"] == nil || out["backgroundSummary"] == nil {
			t.Error("invalid summary final")
		}
		uploads.Add(1)
		w.WriteHeader(204)
	}))
	defer server.Close()
	runHarnessAuthorBridge(t, input, server.URL, "synthetic-module-summary-token", server.Client(), false)
	raw, e := os.ReadFile(handoff)
	var out struct {
		Checked bool `json:"moduleSummaryPromptChecked"`
	}
	if e != nil || json.Unmarshal(raw, &out) != nil || !out.Checked || uploads.Load() != 1 {
		t.Fatal("module summary prompt/upload not verified")
	}
}
