package manager

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// This opt-in entry never discovers credentials. The PM injects model configuration
// in process memory; all files below are isolated synthetic fixture inputs/public CA.
func liveModelMissing(get func(string) string) []string {
	required := []string{"WHIPPET_M106_LIVE_MODEL", "WHIPPET_AI_ENABLED", "WHIPPET_AI_BASE_URL", "WHIPPET_AI_MODEL", "WHIPPET_AI_REASONING_EFFORT", "OPENCODE_API_KEY", "WHIPPET_M10_BRIDGE_URL", "WHIPPET_M10_BRIDGE_CA", "WHIPPET_M10_BRIDGE_TOKEN", "WHIPPET_M10_BRIDGE_INPUT", "WHIPPET_M10_BRIDGE_RESULT", "WHIPPET_M10_WORKER_ENTRY", "WHIPPET_M106_EXPECT_VERSION"}
	var missing []string
	for _, name := range required {
		if get(name) == "" {
			missing = append(missing, name)
		}
	}
	return missing
}

type liveToolObservation struct {
	mu                       sync.Mutex
	pending                  map[string]toolRequest
	searched, read, proposed bool
	calls, success           int
	candidateRef             string
	feedbackMapped           bool
	expected                 string
}

func (o *liveToolObservation) request(q toolRequest) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.pending[q.RequestID] = q
	o.calls++
}
func (o *liveToolObservation) response(raw []byte) {
	var reply toolReply
	if json.Unmarshal(raw, &reply) != nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	q, ok := o.pending[reply.RequestID]
	if ok && reply.AttemptID == q.AttemptID && q.Name == "catalog_search" && reply.Error == "catalog_search_invalid_request" {
		o.feedbackMapped = true
	}
	if !ok || reply.AttemptID != q.AttemptID || reply.Error != "" {
		return
	}
	delete(o.pending, reply.RequestID)
	var result map[string]json.RawMessage
	if json.Unmarshal(reply.Result, &result) != nil || result["error"] != nil {
		return
	}
	o.success++
	switch q.Name {
	case "catalog_search":
		var items []struct {
			VersionID string `json:"versionId"`
		}
		if json.Unmarshal(result["items"], &items) == nil {
			for _, item := range items {
				if item.VersionID == o.expected {
					o.searched = true
				}
			}
		}
	case "catalog_get":
		var args struct {
			VersionID string `json:"moduleVersionId"`
		}
		var version string
		if json.Unmarshal(q.Arguments, &args) == nil && json.Unmarshal(result["versionId"], &version) == nil && o.searched && args.VersionID == o.expected && version == o.expected {
			o.read = true
		}
	case "propose_plan":
		var candidate bool
		var ref string
		var canonical []struct {
			Action    string `json:"action"`
			VersionID string `json:"moduleVersionId"`
		}
		valid := json.Unmarshal(result["candidate"], &candidate) == nil && candidate && json.Unmarshal(result["candidateRef"], &ref) == nil && uuidPattern.MatchString(ref) && json.Unmarshal(result["stages"], &canonical) == nil && len(canonical) == 1
		var proposed struct {
			Stages []struct {
				Action    string `json:"action"`
				VersionID string `json:"moduleVersionId"`
			} `json:"stages"`
		}
		valid = valid && json.Unmarshal(q.Arguments, &proposed) == nil && len(proposed.Stages) == 1 && proposed.Stages[0].Action == "reuse" && proposed.Stages[0].VersionID == o.expected
		if valid && o.read && canonical[0].Action == "reuse" && canonical[0].VersionID == o.expected {
			o.proposed = true
			o.candidateRef = ref
		} else {
			o.proposed = false
			o.candidateRef = ""
		}
	}
}

type observedToolInput struct {
	target      io.Writer
	observation *liveToolObservation
}

func (w *observedToolInput) Write(raw []byte) (int, error) {
	w.observation.response(raw)
	return w.target.Write(raw)
}

type byteCounter struct{ n int }

func (w *byteCounter) Write(raw []byte) (int, error) { w.n += len(raw); return len(raw), nil }

func TestM106LiveModelServerBridge(t *testing.T) {
	if os.Getenv("WHIPPET_M106_LIVE_MODEL") != "1" {
		t.Skip("live model disabled; requires WHIPPET_M106_LIVE_MODEL=1")
	}
	if missing := liveModelMissing(os.Getenv); len(missing) > 0 {
		t.Skip("missing environment names: " + strings.Join(missing, ","))
	}
	if os.Getenv("WHIPPET_AI_ENABLED") != "true" {
		t.Fatal("model explicitly disabled")
	}
	serverURL := os.Getenv("WHIPPET_M10_BRIDGE_URL")
	parsed, e := url.Parse(serverURL)
	if e != nil || parsed.Scheme != "https" || parsed.User != nil || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1") {
		t.Fatal("requires isolated loopback TLS Server")
	}
	token := os.Getenv("WHIPPET_M10_BRIDGE_TOKEN")
	expected := os.Getenv("WHIPPET_M106_EXPECT_VERSION")
	if !strings.HasPrefix(token, "synthetic-") || !uuidPattern.MatchString(expected) {
		t.Fatal("invalid synthetic fixture identity")
	}
	for _, name := range []string{"WHIPPET_M10_BRIDGE_CA", "WHIPPET_M10_BRIDGE_INPUT", "WHIPPET_M10_BRIDGE_RESULT", "WHIPPET_M10_WORKER_ENTRY"} {
		if !filepath.IsAbs(os.Getenv(name)) {
			t.Fatal("fixture paths must be absolute")
		}
	}
	raw, e := os.ReadFile(os.Getenv("WHIPPET_M10_BRIDGE_INPUT"))
	if e != nil {
		t.Fatal("cannot read synthetic input")
	}
	var input WorkerInput
	if json.Unmarshal(raw, &input) != nil || !plannerAuthor(input.Author) {
		t.Fatal("requires planner input")
	}
	var model skillModel
	var budget skillBudget
	if json.Unmarshal(input.Author.Model, &model) != nil || model.Provider != "opencode" || model.Model != os.Getenv("WHIPPET_AI_MODEL") || model.ReasoningEffort != os.Getenv("WHIPPET_AI_REASONING_EFFORT") || json.Unmarshal(input.Author.Budget, &budget) != nil || budget.MaxModelRequests < 4 || budget.MaxModelRequests > 8 || budget.MaxToolCalls < 3 || budget.MaxToolCalls > 12 || budget.MaxDurationMS < 1 || budget.MaxDurationMS > 180000 {
		t.Fatal("invalid pinned model/budget")
	}
	for _, name := range []string{"catalog_search", "catalog_get", "propose_plan"} {
		if !hasAllowedTool(input.Author, name) {
			t.Fatal("missing required fixture capability")
		}
	}
	d := Dispatch{Kind: input.Kind, Script: input.Script, TimeoutMS: input.TimeoutMS, Author: input.Author, WorkspaceID: input.WorkspaceID, TestID: input.TestID, WorkspaceContext: input.WorkspaceContext, WorkspaceSettings: input.WorkspaceSettings, ScriptOrigin: input.ScriptOrigin}
	if validDispatch(d) != nil {
		t.Fatal("invalid authoritative fixture input")
	}
	ca, e := os.ReadFile(os.Getenv("WHIPPET_M10_BRIDGE_CA"))
	if e != nil {
		t.Fatal("cannot read synthetic public CA")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		t.Fatal("invalid synthetic public CA")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	defer transport.CloseIdleConnections()
	httpObservation := &liveHTTPObservation{base: transport, statuses: map[int]int{}, codes: map[string]int{}}
	client := &http.Client{Transport: httpObservation, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errCapability }}
	root := t.TempDir()
	work := filepath.Join(root, "runs", input.AttemptID)
	if os.MkdirAll(work, 0700) != nil {
		t.Fatal("cannot create isolated work directory")
	}
	if os.WriteFile(filepath.Join(work, "input.json"), raw, 0600) != nil {
		t.Fatal("cannot write synthetic input")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(budget.MaxDurationMS+30000)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", os.Getenv("WHIPPET_M10_WORKER_ENTRY"))
	for _, name := range []string{"PATH", "HOME", "TMPDIR", "LANG", "WHIPPET_TOOL_REGISTRY_PATH", "WHIPPET_SKILLS_PATH", "WHIPPET_AI_ENABLED", "WHIPPET_AI_BASE_URL", "WHIPPET_AI_MODEL", "WHIPPET_AI_REASONING_EFFORT", "OPENCODE_API_KEY"} {
		if value := os.Getenv(name); value != "" {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "WHIPPET_WORK_DIR="+work, "WHIPPET_M106_OBSERVE=1")
	stdin, e := cmd.StdinPipe()
	if e != nil {
		t.Fatal("cannot open Worker pipe")
	}
	defer stdin.Close()
	writer := &attemptInputWriter{ctx: ctx, input: stdin}
	defer writer.close()
	observation := &liveToolObservation{pending: map[string]toolRequest{}, expected: expected}
	r := record{Kind: "author", RunID: input.RunID, AttemptID: input.AttemptID, Author: input.Author, TimeoutMS: input.TimeoutMS, WorkspaceID: input.WorkspaceID, TestID: input.TestID, WorkspaceContext: input.WorkspaceContext}
	channel := &toolChannel{ctx: ctx, cfg: Config{ServerURL: serverURL, Token: token}, r: r, input: &observedToolInput{target: writer, observation: observation}, client: client}
	modelRequests := 0
	observer := newLiveObserver()
	defer func() {
		observation.mu.Lock()
		observer.Flags["feedbackMapped"] = observation.feedbackMapped
		observation.mu.Unlock()
		safe, _ := json.Marshal(observer)
		t.Logf("liveObserver=%s", safe)
	}()
	cmd.Stdout = &lineWriter{toolFrames: true, intercept: func(line string) bool {
		var q toolRequest
		if json.Unmarshal([]byte(line), &q) == nil && q.Kind == "tool_request" {
			observation.request(q)
		}
		return channel.handle(line)
	}, emit: func(_ string, text string) {
		observer.accept(text)
		if strings.HasPrefix(text, "author:model:") && strings.HasSuffix(text, ":started") {
			modelRequests++
		}
	}}
	stderr := &byteCounter{}
	cmd.Stderr = stderr
	if cmd.Run() != nil {
		if ctx.Err() == context.DeadlineExceeded {
			observer.ManagerProcessDeadline = 1
		}
		observation.mu.Lock()
		calls, success, searched, read, proposed := observation.calls, observation.success, observation.searched, observation.read, observation.proposed
		observation.mu.Unlock()
		httpObservation.mu.Lock()
		diagnostic, _ := json.Marshal(map[string]any{"workerClass": liveWorkerFileClass(work), "modelStarts": modelRequests, "genericIPC": calls, "toolSuccess": success, "http200": httpObservation.ok, "httpNon200": httpObservation.failed, "httpStatuses": httpObservation.statuses, "httpCodes": httpObservation.codes, "toolNames": httpObservation.names, "search": searched, "get": read, "propose": proposed})
		httpObservation.mu.Unlock()
		t.Logf("liveDiagnostic=%s", diagnostic)
		t.Fatalf("live Worker failed; modelRequests=%d stderrBytes=%d (details suppressed)", modelRequests, stderr.n)
	}
	result, names := collectAttemptResult(r, work, execution{ExitCode: 0})
	if result.Status != "succeeded" || len(names) != 1 || names[0] != "author.json" {
		t.Fatal("Manager rejected live artifact")
	}
	var answer struct {
		Candidate struct {
			Ref string `json:"candidateRef"`
		} `json:"planCandidate"`
	}
	if readOutput(work, "author.json", &answer, input.Author) != nil {
		t.Fatal("invalid live artifact")
	}
	observation.mu.Lock()
	passed := observation.searched && observation.read && observation.proposed && answer.Candidate.Ref == observation.candidateRef
	calls, success := observation.calls, observation.success
	observation.mu.Unlock()
	if !passed || modelRequests < 1 {
		t.Fatal("live model did not search, read and propose the fixed reuse version")
	}
	manager := &Manager{cfg: Config{ServerURL: serverURL, Token: token, WorkDir: root}, http: client}
	if manager.upload(ctx, r, "author.json") != nil {
		t.Fatal("live artifact upload failed")
	}
	handoff := map[string]any{"runId": r.RunID, "attemptId": r.AttemptID, "result": result, "artifactUploaded": true, "liveModel": true, "catalogSearch": true, "catalogGet": true, "reuseVersionId": expected, "candidateRef": answer.Candidate.Ref, "modelRequests": modelRequests, "genericIPC": calls, "toolSuccess": success}
	raw, _ = json.Marshal(handoff)
	if os.WriteFile(os.Getenv("WHIPPET_M10_BRIDGE_RESULT"), raw, 0600) != nil {
		t.Fatal("cannot write safe handoff")
	}
	t.Logf("liveModel=true search=true get=true reuse=true artifactUploaded=true modelRequests=%d genericIPC=%d toolSuccess=%d; Server persistence assertion belongs to outer PG fixture", modelRequests, calls, success)
}

func TestM106LiveModelEnvironmentGate(t *testing.T) {
	if len(liveModelMissing(func(string) string { return "" })) != 13 {
		t.Fatal("required environment gate changed")
	}
	if len(liveModelMissing(func(string) string { return "injected" })) != 0 {
		t.Fatal("complete environment rejected")
	}
}

func TestM106LiveModelPackagedPlanner(t *testing.T) {
	a := platformAuthorFixture(t, "usecase-planner")
	actualSkillPin(t, a)
	var budget skillBudget
	var model skillModel
	if json.Unmarshal(a.Budget, &budget) != nil || budget.MaxModelRequests != 8 || budget.MaxToolCalls != 12 || budget.MaxDurationMS != 180000 {
		t.Fatal("Server live fixture budget no longer matches packaged planner")
	}
	if json.Unmarshal(a.Model, &model) != nil || model.Provider != "opencode" || model.Model == "" || model.ReasoningEffort == "" {
		t.Fatal("invalid pinned model")
	}
	if _, err := validCapabilitySnapshot(a); err != nil {
		t.Fatal("packaged registry/primary pins invalid")
	}
}
