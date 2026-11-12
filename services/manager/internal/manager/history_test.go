package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func historyFixture(t *testing.T) (record, historyRequest, historyPage) {
	t.Helper()
	d := m8Dispatch(t)
	d.Author.History = &HistoryPin{MaxSequence: "9007199254740993"}
	*d.Author.AllowedTools = []string{"read_conversation_history"}
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Author: d.Author, WorkspaceID: d.WorkspaceID, TestID: d.TestID, WorkspaceContext: d.WorkspaceContext}
	q := historyRequest{Kind: "history_request", RequestID: newID(), AttemptID: r.AttemptID}
	p := historyPage{WorkspaceID: r.WorkspaceID, TestID: nil, RunID: r.RunID, AttemptID: r.AttemptID, ConversationID: r.Author.ConversationID, MaxSequence: r.Author.History.MaxSequence, Items: []historyItem{{Sequence: "9007199254740992", Role: "user", Content: "較早決策", OffsetBytes: 0, HasMoreContent: false}}}
	return r, q, p
}
func TestM9HistoryHTTPRequiresTLSOwnerCutoffNoStoreAndNoRedirect(t *testing.T) {
	r, q, page := historyFixture(t)
	mode := "good"
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		if req.Method != "POST" || req.URL.Path != "/api/manager/runs/"+r.RunID+"/attempts/"+r.AttemptID+"/history" || req.Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Error("wrong trusted request")
		}
		body, _ := io.ReadAll(req.Body)
		if string(body) != "{\"cursor\":null}" {
			t.Error("unexpected scope in body")
		}
		w.Header().Set("Cache-Control", "no-store")
		reply := page
		switch mode {
		case "redirect":
			w.Header().Set("Location", "/other")
			w.WriteHeader(302)
			return
		case "nostore":
			w.Header().Del("Cache-Control")
		case "owner":
			reply.WorkspaceID = newID()
		case "attempt":
			reply.AttemptID = newID()
		case "cutoff":
			reply.MaxSequence = "9007199254740994"
		case "future":
			reply.Items = append([]historyItem{}, page.Items...)
			reply.Items[0].Sequence = "9007199254740994"
		case "error":
			w.WriteHeader(409)
			w.Write([]byte("internal details never relayed"))
			return
		}
		json.NewEncoder(w).Encode(reply)
	}))
	defer server.Close()
	cfg := Config{ServerURL: server.URL, Token: "synthetic-token"}
	if _, err := readHistory(context.Background(), cfg, r, q, server.Client()); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"redirect", "nostore", "owner", "attempt", "cutoff", "future", "error"} {
		mode = bad
		if _, err := readHistory(context.Background(), cfg, r, q, server.Client()); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	if calls != 8 {
		t.Fatal("redirect retried")
	}
	cfg.ServerURL = strings.Replace(server.URL, "https:", "http:", 1)
	if _, err := readHistory(context.Background(), cfg, r, q, server.Client()); err == nil {
		t.Fatal("plaintext accepted")
	}
}
func TestM9HistoryFragmentBoundsAndStrictMetadata(t *testing.T) {
	r, q, page := historyFixture(t)
	check := func(p historyPage, q historyRequest) error {
		raw, _ := json.Marshal(p)
		_, err := validHistoryPage(raw, r, q)
		return err
	}
	page.Items[0].Content = "繁體"
	page.Items[0].HasMoreContent = true
	cursor := "9007199254740992:6"
	page.NextCursor = &cursor
	if err := check(page, q); err != nil {
		t.Fatal(err)
	}
	q.Cursor = &cursor
	page.Items[0].OffsetBytes = 6
	page.Items[0].HasMoreContent = false
	page.NextCursor = nil
	if err := check(page, q); err != nil {
		t.Fatal(err)
	}
	page.Items[0].OffsetBytes = 3
	if check(page, q) == nil {
		t.Fatal("wrong byte continuation accepted")
	}
	q.Cursor = nil
	page.Items[0].OffsetBytes = 0
	page.Items[0].Content = strings.Repeat("測", 2731)
	if check(page, q) == nil {
		t.Fatal("byte limit ignored")
	}
	_, _, page = historyFixture(t)
	page.WorkspaceID = r.WorkspaceID
	page.RunID = r.RunID
	page.AttemptID = r.AttemptID
	page.ConversationID = r.Author.ConversationID
	raw, _ := json.Marshal(page)
	raw = bytes.Replace(raw, []byte(`"offsetBytes":0`), []byte(`"offsetBytes":null`), 1)
	if _, err := validHistoryPage(raw, r, q); err == nil {
		t.Fatal("null offset accepted")
	}
	d := m8Dispatch(t)
	d.Author.History = &HistoryPin{MaxSequence: "42"}
	*d.Author.AllowedTools = []string{"read_conversation_history"}
	if err := validDispatch(d); err != nil {
		t.Fatal(err)
	}
	*d.Author.SkillID = "acceptance-summary"
	if validDispatch(d) == nil {
		t.Fatal("summary gained history")
	}
	d = m8Dispatch(t)
	*d.Author.AllowedTools = []string{"read_conversation_history"}
	if validDispatch(d) == nil {
		t.Fatal("history without fixed cutoff")
	}
	if !authorProgressPattern.MatchString("author:tool:1:read_conversation_history:succeeded") {
		t.Fatal("safe progress missing")
	}
}

type historySink struct {
	mu    sync.Mutex
	data  bytes.Buffer
	ready chan struct{}
}

func (s *historySink) Write(data []byte) (int, error) {
	s.mu.Lock()
	n, e := s.data.Write(data)
	s.mu.Unlock()
	s.ready <- struct{}{}
	return n, e
}
func (s *historySink) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.data.String() }
func TestM9HistoryChannelQuotaDedupCancellationAndNoLog(t *testing.T) {
	r, q, page := historyFixture(t)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(page)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := &historySink{ready: make(chan struct{}, 10)}
	channel := historyChannel{ctx: ctx, cfg: Config{ServerURL: server.URL}, r: r, input: sink, client: server.Client()}
	logs := 0
	writer := lineWriter{emit: func(string, string) { logs++ }, intercept: channel.handle}
	for i := 0; i < 5; i++ {
		q.RequestID = newID()
		raw, _ := json.Marshal(q)
		writer.Write(append(raw, '\n'))
		select {
		case <-sink.ready:
		case <-time.After(2 * time.Second):
			t.Fatal("no bounded reply")
		}
		// Wait for the handler's bookkeeping, not an arbitrary sleep.
		deadline := time.Now().Add(time.Second)
		for {
			channel.mu.Lock()
			pending := channel.pending
			channel.mu.Unlock()
			if !pending {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("pending not released")
			}
			runtime.Gosched()
		}
		if i == 0 {
			channel.handle(string(raw))
			channel.mu.Lock()
			count := channel.count
			channel.mu.Unlock()
			if count != 1 {
				t.Fatal("duplicate request spent quota or retried")
			}
		}
	}
	if logs != 0 || channel.count != 5 {
		t.Fatal("metadata logged or quota lost")
	}
	if strings.Count(sink.String(), `"history":`) != 4 || strings.Count(sink.String(), `"error":"history_unavailable"`) != 1 {
		t.Fatal("quota reply incorrect")
	}
	channel.mu.Lock()
	count := channel.count
	channel.mu.Unlock()
	q.RequestID = "bad"
	raw, _ := json.Marshal(q)
	channel.handle(string(raw))
	if channel.count != count {
		t.Fatal("invalid ID used request")
	}
	cancel()
	before := sink.String()
	q.RequestID = newID()
	raw, _ = json.Marshal(q)
	channel.handle(string(raw))
	if sink.String() != before {
		t.Fatal("cancelled frame replied")
	}
}

func TestM9HistoryPendingHTTPStopsOnCancellation(t *testing.T) {
	r, q, _ := historyFixture(t)
	started := make(chan struct{})
	stopped := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// Consume the POST body so net/http can observe peer closure while the
		// handler waits; an unread request body prevents that background read.
		_, _ = io.Copy(io.Discard, req.Body)
		close(started)
		select {
		case <-req.Context().Done():
			close(stopped)
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sink := &historySink{ready: make(chan struct{}, 1)}
	channel := historyChannel{ctx: ctx, cfg: Config{ServerURL: server.URL}, r: r, input: sink, client: server.Client()}
	raw, _ := json.Marshal(q)
	channel.handle(string(raw))
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("HTTP never started")
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("HTTP not cancelled")
	}
	deadline := time.Now().Add(time.Second)
	for {
		channel.mu.Lock()
		pending := channel.pending
		channel.mu.Unlock()
		if !pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pending survived cancellation")
		}
		runtime.Gosched()
	}
	if sink.String() != "" {
		t.Fatal("cancelled HTTP response reached stdin")
	}
}

type splitWriter struct{ data bytes.Buffer }

func (w *splitWriter) Write(p []byte) (int, error) {
	for _, b := range p {
		w.data.WriteByte(b)
		runtime.Gosched()
	}
	return len(p), nil
}
func TestM9AttemptStdinWritesWholeCredentialAndHistoryFrames(t *testing.T) {
	sink := &splitWriter{}
	input := attemptInputWriter{ctx: context.Background(), input: sink}
	var wg sync.WaitGroup
	for _, kind := range []string{"credential_response", "history_response"} {
		wg.Add(1)
		go func(kind string) {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				raw, _ := json.Marshal(map[string]any{"kind": kind, "padding": strings.Repeat("合成", 30)})
				if _, err := input.Write(append(raw, '\n')); err != nil {
					t.Error(err)
				}
			}
		}(kind)
	}
	wg.Wait()
	lines := strings.Split(strings.TrimSpace(sink.data.String()), "\n")
	if len(lines) != 40 {
		t.Fatal("frames interleaved")
	}
	for _, line := range lines {
		if !json.Valid([]byte(line)) {
			t.Fatal("invalid atomic frame")
		}
	}
	input.close()
	if _, err := input.Write([]byte("late\n")); err == nil {
		t.Fatal("closed writer accepted reply")
	}
}
