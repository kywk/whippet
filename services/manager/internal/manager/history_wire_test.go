package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Opt-in cross-module check: actual Node author entrypoint and process pipes,
// Manager stdout interceptor / stdin writer / HTTPS client, synthetic provider.
func TestM9HistoryRealAuthorIPCAndManagerTLS(t *testing.T) {
	entry := os.Getenv("WHIPPET_M9_WORKER_ENTRY")
	if entry == "" {
		t.Skip("set WHIPPET_M9_WORKER_ENTRY to the existing compiled author/main.js")
	}
	entry, err := filepath.Abs(entry)
	if err != nil {
		t.Fatal(err)
	}
	d := m7Dispatch(t, false)
	d.WorkspaceID = newID()
	testID := newID()
	d.TestID, _ = json.Marshal(testID)
	d.WorkspaceContext, _ = json.Marshal(map[string]any{"schemaVersion": "1", "workspaceId": d.WorkspaceID, "settingsRevision": 1, "config": nil, "roleRefs": []any{}})
	d.Author.History = &HistoryPin{MaxSequence: "62"}
	*d.Author.AllowedTools = []string{"read_conversation_history"}
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Author: d.Author, WorkspaceID: d.WorkspaceID, TestID: d.TestID, WorkspaceContext: d.WorkspaceContext}
	const marker = "synthetic-cross-process-decision"
	var models, requests, toolSuccess, toolFailure atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if req.URL.Path == "/v1/responses" {
			var body struct {
				Input []json.RawMessage `json:"input"`
			}
			if json.NewDecoder(req.Body).Decode(&body) != nil {
				t.Error("invalid model request")
				w.WriteHeader(400)
				return
			}
			n := models.Add(1)
			var last struct {
				Type   string `json:"type"`
				Output string `json:"output"`
			}
			for _, raw := range body.Input {
				var item struct {
					Type   string `json:"type"`
					Output string `json:"output"`
				}
				_ = json.Unmarshal(raw, &item)
				if item.Type == "function_call_output" {
					last = item
				}
			}
			if n < 3 {
				var cursor any = "null" // The exact first-page spelling observed from the real model.
				if n == 2 {
					var page struct {
						NextCursor *string `json:"nextCursor"`
					}
					if json.Unmarshal([]byte(last.Output), &page) != nil || page.NextCursor == nil {
						t.Error("first history page did not reach model")
					} else {
						cursor = page.NextCursor
					}
				}
				args, _ := json.Marshal(map[string]any{"cursor": cursor})
				json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{map[string]any{"type": "function_call", "call_id": "history-" + strconv.Itoa(int(n)), "name": "read_conversation_history", "arguments": string(args)}}})
				return
			}
			answer := "history unavailable"
			if strings.Contains(last.Output, marker) {
				answer = marker
			}
			final, _ := json.Marshal(map[string]any{"message": answer})
			json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{}, "output_text": string(final)})
			return
		}
		if req.URL.Path != "/api/manager/runs/"+r.RunID+"/attempts/"+r.AttemptID+"/history" {
			w.WriteHeader(404)
			return
		}
		if req.Header.Get("Authorization") != "Bearer synthetic-manager-token" {
			t.Error("manager auth missing")
			w.WriteHeader(401)
			return
		}
		var query struct {
			Cursor *string `json:"cursor"`
		}
		if json.NewDecoder(req.Body).Decode(&query) != nil {
			t.Error("invalid history body")
			w.WriteHeader(400)
			return
		}
		requests.Add(1)
		start := int64(62)
		if query.Cursor != nil {
			var ok bool
			start, _, ok = parseHistoryCursor(query.Cursor, "62")
			if !ok {
				w.WriteHeader(400)
				return
			}
		}
		items := []historyItem{}
		for seq := start; seq > start-6 && seq >= 51; seq-- {
			content := "synthetic padding"
			if seq == 51 {
				content = marker
			}
			items = append(items, historyItem{Sequence: strconv.FormatInt(seq, 10), Role: "user", Content: content})
		}
		var next *string
		if start == 62 {
			value := "56:0"
			next = &value
		}
		json.NewEncoder(w).Encode(historyPage{WorkspaceID: r.WorkspaceID, TestID: &testID, RunID: r.RunID, AttemptID: r.AttemptID, EditingSessionID: r.Author.EditingSessionID, ConversationID: r.Author.ConversationID, MaxSequence: "62", Items: items, NextCursor: next})
	}))
	defer server.Close()
	work := t.TempDir()
	cert := filepath.Join(work, "synthetic-ca.pem")
	if err = os.WriteFile(cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	input := WorkerInput{RunID: r.RunID, AttemptID: r.AttemptID, Script: d.Script, TimeoutMS: 180000, Kind: "author", Author: r.Author, WorkspaceSettings: d.WorkspaceSettings, WorkspaceID: r.WorkspaceID, TestID: r.TestID, WorkspaceContext: r.WorkspaceContext}
	raw, _ := json.Marshal(input)
	if err = os.WriteFile(filepath.Join(work, "input.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", entry)
	for _, env := range os.Environ() {
		name, _, _ := strings.Cut(env, "=")
		if strings.HasPrefix(name, "WHIPPET_AI_") || name == "OPENCODE_API_KEY" || name == "NODE_EXTRA_CA_CERTS" || name == "NODE_TLS_REJECT_UNAUTHORIZED" || name == "NODE_OPTIONS" || name == "WHIPPET_WORK_DIR" {
			continue
		}
		cmd.Env = append(cmd.Env, env)
	}
	cmd.Env = append(cmd.Env, "WHIPPET_WORK_DIR="+work, "NODE_EXTRA_CA_CERTS="+cert, "WHIPPET_AI_ENABLED=true", "WHIPPET_AI_BASE_URL="+server.URL+"/v1", "WHIPPET_AI_MODEL=synthetic-m9", "WHIPPET_AI_REASONING_EFFORT=high", "OPENCODE_API_KEY=synthetic-provider-token")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	writer := &attemptInputWriter{ctx: ctx, input: stdin}
	defer writer.close()
	channel := &historyChannel{ctx: ctx, cfg: Config{ServerURL: server.URL, Token: "synthetic-manager-token"}, r: r, input: writer, client: server.Client()}
	cmd.Stdout = &lineWriter{intercept: channel.handle, emit: func(_ string, text string) {
		if strings.HasSuffix(text, ":read_conversation_history:succeeded") {
			toolSuccess.Add(1)
		}
		if strings.HasSuffix(text, ":read_conversation_history:failed") {
			toolFailure.Add(1)
		}
	}}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Run(); err != nil {
		t.Fatalf("author process failed: error=%v stderrBytes=%d", err, stderr.Len())
	}
	output, err := os.ReadFile(filepath.Join(work, "output", "author.json"))
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(output, &answer) != nil {
		t.Fatal("invalid author output")
	}
	matched := answer.Message == marker
	t.Logf("modelRequests=%d historyHTTP=%d historySucceeded=%d historyFailed=%d markerMatch=%t", models.Load(), requests.Load(), toolSuccess.Load(), toolFailure.Load(), matched)
	if models.Load() != 3 || requests.Load() != 2 || toolSuccess.Load() != 2 || toolFailure.Load() != 0 || !matched {
		t.Fatal("real author IPC -> Manager HTTPS did not retrieve the older decision")
	}
	_, _ = io.Copy(io.Discard, &stderr)
}

func TestM9HistoryDockerAttachStdin(t *testing.T) {
	image := os.Getenv("WHIPPET_M9_WORKER_IMAGE")
	if image == "" {
		t.Skip("set WHIPPET_M9_WORKER_IMAGE to an existing M9 image")
	}
	r, _, page := historyFixture(t)
	testID := newID()
	r.TestID, _ = json.Marshal(testID)
	skill := "test-author"
	r.Author.SkillID = &skill
	session := newID()
	r.Author.EditingSessionID = &session
	page.TestID = &testID
	page.EditingSessionID = &session
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requests.Add(1)
		_, _ = io.Copy(io.Discard, req.Body)
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(page)
	}))
	defer server.Close()
	// The host-side Docker CLI driver runs on macOS, whose system verifier
	// does not use the Linux Manager's SSL_CERT_FILE mechanism. Give this
	// isolated test the httptest CA through its process-local transport.
	originalTransport := http.DefaultTransport
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	http.DefaultTransport = transport
	t.Cleanup(func() { transport.CloseIdleConnections(); http.DefaultTransport = originalTransport })
	input := WorkerInput{RunID: r.RunID, AttemptID: r.AttemptID, Kind: "author", WorkspaceID: r.WorkspaceID, TestID: r.TestID, Author: r.Author, WorkspaceContext: r.WorkspaceContext}
	raw, _ := json.Marshal(input)
	script := `import {HistoryClient} from './dist/author/history.js';import {CredentialClient} from './dist/login/client.js';
const input=` + string(raw) + `;const credentials=new CredentialClient(input);const history=new HistoryClient(input);
await new Promise(resolve=>setTimeout(resolve,100));
try{await history.read(null);console.log(JSON.stringify({kind:'log',message:'author:tool:1:read_conversation_history:succeeded'}));}
catch{console.log(JSON.stringify({kind:'log',message:'author:tool:1:read_conversation_history:failed'}));process.exitCode=1;}
finally{history.close();credentials.close();}`
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	d := dockerCLI{cfg: Config{ServerURL: server.URL, Token: "synthetic-token", ManagerID: "m9-isolated-stdin", WorkerImage: image}}
	create := dockerCommand(ctx, "create", "--name", d.name(r), "--init", "--interactive", "--network=none", "--entrypoint", "node", image, "--input-type=module", "-e", script)
	if output, err := create.CombinedOutput(); err != nil {
		t.Fatalf("isolated docker create failed: %v outputBytes=%d", err, len(output))
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if err := d.Remove(cleanup, r); err != nil {
			t.Error("isolated container cleanup failed")
		}
	}()
	var success, failure atomic.Int32
	outcome := d.attach(ctx, r, func(_ string, text string) {
		if strings.HasSuffix(text, ":read_conversation_history:succeeded") {
			success.Add(1)
		}
		if strings.HasSuffix(text, ":read_conversation_history:failed") {
			failure.Add(1)
		}
	})
	t.Logf("dockerExit=%d historyHTTP=%d historySucceeded=%d historyFailed=%d", outcome.ExitCode, requests.Load(), success.Load(), failure.Load())
	if outcome.ExitCode != 0 || requests.Load() != 1 || success.Load() != 1 || failure.Load() != 0 {
		t.Fatal("actual Docker attach/stdin history failed")
	}
}
