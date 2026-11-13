package manager

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type frameSink struct {
	mu     sync.Mutex
	frames chan []byte
}

func (s *frameSink) Write(raw []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames <- append([]byte(nil), raw...)
	return len(raw), nil
}
func nextToolReply(t *testing.T, s *frameSink) toolReply {
	t.Helper()
	select {
	case raw := <-s.frames:
		var out toolReply
		if json.Unmarshal(raw, &out) != nil {
			t.Fatal("invalid reply")
		}
		return out
	case <-time.After(2 * time.Second):
		t.Fatal("reply timeout")
		return toolReply{}
	}
}
func harnessFixture(t *testing.T) (record, toolRequest, historyPage) {
	r, q, page := historyFixture(t)
	a := v10Author(t)
	a.History = r.Author.History
	*a.AllowedTools = []string{"read_conversation_history"}
	r.Author = a
	r.TimeoutMS = 180000
	testID := newID()
	r.TestID, _ = json.Marshal(testID)
	page.TestID = &testID
	page.EditingSessionID = a.EditingSessionID
	page.ConversationID = a.ConversationID
	return r, toolRequest{Kind: "tool_request", RequestID: q.RequestID, AttemptID: r.AttemptID, Name: "read_conversation_history", Arguments: json.RawMessage(`{"cursor":null}`)}, page
}
func encodeTool(t *testing.T, q toolRequest) string {
	t.Helper()
	raw, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
func TestM10HarnessRoutingScopeReplayAndActiveAttempt(t *testing.T) {
	r, q, page := harnessFixture(t)
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requests.Add(1)
		if req.URL.Path != "/api/manager/runs/"+r.RunID+"/attempts/"+r.AttemptID+"/tools" || req.Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Error("wrong endpoint/auth")
		}
		var body struct {
			CallID    string          `json:"callId"`
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body.CallID != q.RequestID || body.Name != q.Name || string(body.Arguments) != `{"cursor":null}` {
			t.Error("IPC identity changed")
		}
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"runId": r.RunID, "attemptId": r.AttemptID, "callId": body.CallID, "result": page})
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := &frameSink{frames: make(chan []byte, 8)}
	channel := &toolChannel{ctx: ctx, cfg: Config{ServerURL: server.URL, Token: "synthetic-token"}, r: r, input: sink, client: server.Client()}
	if !channel.handle(encodeTool(t, q)) {
		t.Fatal("not intercepted")
	}
	if reply := nextToolReply(t, sink); reply.Error != "" || reply.RequestID != q.RequestID {
		t.Fatal("tool failed")
	}
	channel.handle(encodeTool(t, q))
	if reply := nextToolReply(t, sink); reply.Error != "" {
		t.Fatal("replay failed")
	}
	if requests.Load() != 1 {
		t.Fatal("replay called server twice")
	}
	changed := q
	changed.Arguments = json.RawMessage(`{"cursor":"1:0"}`)
	channel.handle(encodeTool(t, changed))
	if nextToolReply(t, sink).Error != "tool_unavailable" {
		t.Fatal("same ID different content accepted")
	}
	wrong := q
	wrong.AttemptID = newID()
	channel.handle(encodeTool(t, wrong))
	if requests.Load() != 1 {
		t.Fatal("foreign attempt reached server")
	}
	legacy := &historyChannel{ctx: ctx, r: r, input: sink, client: server.Client()}
	old, _ := json.Marshal(historyRequest{Kind: "history_request", RequestID: newID(), AttemptID: r.AttemptID})
	if !legacy.handle(string(old)) {
		t.Fatal("legacy downgrade not consumed")
	}
	cancel()
	channel.handle(encodeTool(t, q))
	select {
	case <-sink.frames:
		t.Fatal("cancelled attempt emitted reply")
	default:
	}
}
func TestM10HarnessRejectsForeignScopeAndDropsLateResult(t *testing.T) {
	r, q, page := harnessFixture(t)
	for _, mode := range []string{"scope", "late", "nostore", "redirect", "outer-attempt"} {
		t.Run(mode, func(t *testing.T) {
			started := make(chan struct{})
			release := make(chan struct{})
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				close(started)
				if mode == "late" {
					<-release
				}
				w.Header().Set("Cache-Control", "no-store")
				result := page
				attempt := r.AttemptID
				if mode == "scope" {
					result.WorkspaceID = newID()
				}
				if mode == "outer-attempt" {
					attempt = newID()
				}
				if mode == "nostore" {
					w.Header().Del("Cache-Control")
				}
				if mode == "redirect" {
					http.Redirect(w, req, "/elsewhere", 302)
					return
				}
				json.NewEncoder(w).Encode(map[string]any{"runId": r.RunID, "attemptId": attempt, "callId": q.RequestID, "result": result})
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sink := &frameSink{frames: make(chan []byte, 2)}
			channel := &toolChannel{ctx: ctx, cfg: Config{ServerURL: server.URL}, r: r, input: sink, client: server.Client()}
			channel.handle(encodeTool(t, q))
			<-started
			if mode == "late" {
				cancel()
				close(release)
				select {
				case <-sink.frames:
					t.Fatal("late result forwarded")
				case <-time.After(30 * time.Millisecond):
				}
				return
			}
			if nextToolReply(t, sink).Error != "tool_unavailable" {
				t.Fatal("invalid response accepted")
			}
		})
	}
}
func TestM10HarnessFrameLimitsStaySeparate(t *testing.T) {
	var intercepted, logs int
	writer := &lineWriter{toolFrames: true, intercept: func(string) bool { intercepted++; return true }, emit: func(string, string) { logs++ }}
	raw, _ := json.Marshal(map[string]any{"kind": "tool_request", "arguments": strings.Repeat("x", credentialFrameLimit)})
	_, _ = writer.Write(append(raw, '\n'))
	if intercepted != 1 {
		t.Fatal("generic frame truncated at legacy cap")
	}
	raw, _ = json.Marshal(map[string]any{"kind": "credential_request", "data": strings.Repeat("x", credentialFrameLimit)})
	_, _ = writer.Write(append(raw, '\n'))
	if intercepted != 1 || logs != 0 {
		t.Fatal("credential cap relaxed")
	}
	raw, _ = json.Marshal(map[string]any{"kind": "tool_request", "arguments": strings.Repeat("x", toolFrameLimit)})
	_, _ = writer.Write(append(raw, '\n'))
	if intercepted != 1 || logs != 0 {
		t.Fatal("oversized tool frame accepted or logged")
	}
	legacy := &lineWriter{intercept: func(string) bool { t.Fatal("v9 large frame accepted"); return true }, emit: func(string, string) { t.Fatal("large frame logged") }}
	_, _ = legacy.Write(append(raw, '\n'))
}
