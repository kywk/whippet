package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestM9HistoryCursor(t *testing.T) {
	for _, value := range []string{"", "1", "1:0:0", "-1:0", "01:0", "1:-1", "1:01", "1:1.5", "1:9007199254740992", "9223372036854775808:0", "11:0", " 1:0"} {
		if _, _, err := historyCursor(&value, 10); err == nil {
			t.Fatalf("invalid cursor accepted: %q", value)
		}
	}
	for _, value := range []string{"0:0", "10:0", "5:9007199254740991"} {
		if _, _, err := historyCursor(&value, 10); err != nil {
			t.Fatalf("valid cursor rejected: %q", value)
		}
	}
	if seq, offset, err := historyCursor(nil, 0); err != nil || seq != 0 || offset != 0 {
		t.Fatal("empty history bound")
	}
}

func TestM9HistoryUTF8Pagination(t *testing.T) {
	texts := []string{"old decision", strings.Repeat("台🙂\\\n", 1500), "newer"}
	var cursor *string
	var rebuilt [3]string
	for page := 0; page < 10; page++ {
		seq, offset, err := historyCursor(cursor, 3)
		if err != nil {
			t.Fatal(err)
		}
		rows := []historyRow{}
		for n := seq; n > 0; n-- {
			start := int64(0)
			if n == seq {
				start = offset
			}
			body := []byte(texts[n-1])
			rows = append(rows, historyRow{n, "user", body[start:min(int64(len(body)), start+historyPageBytes+4)], int64(len(body))})
		}
		items, next, err := historyFragments(rows, seq, offset)
		if err != nil || len(items) > historyPageItems {
			t.Fatal("page", err)
		}
		bytes := 0
		for _, item := range items {
			n, _ := strconv.Atoi(item.Sequence)
			if !utf8.ValidString(item.Content) || int(item.OffsetBytes) != len(rebuilt[n-1]) {
				t.Fatal("UTF-8 boundary/continuation lost")
			}
			rebuilt[n-1] += item.Content
			bytes += len(item.Content)
		}
		if bytes > historyPageBytes {
			t.Fatal("page byte limit exceeded")
		}
		cursor = next
		if next == nil {
			break
		}
	}
	for n, text := range texts {
		if rebuilt[n] != text {
			t.Fatalf("message %d skipped bytes", n)
		}
	}
	rows := []historyRow{{3, "user", []byte{0xb0, 0x80}, 3}}
	if _, _, err := historyFragments(rows, 3, 1); err == nil {
		t.Fatal("offset in middle of UTF-8 accepted")
	}
	if _, _, err := historyFragments(rows, 4, 1); err == nil {
		t.Fatal("offset into missing/foreign sequence accepted")
	}
	if _, _, err := historyFragments(rows, 3, 4); err == nil {
		t.Fatal("offset beyond message accepted")
	}
	rows = []historyRow{}
	for n := int64(8); n > 0; n-- {
		rows = append(rows, historyRow{n, "assistant", []byte("x"), 1})
	}
	items, next, err := historyFragments(rows, 8, 1)
	if err != nil || len(items) != 6 || next == nil || *next != "1:0" {
		t.Fatal("end-of-message cursor lost older lookahead", err)
	}
	items, next, err = historyFragments(nil, 0, 0)
	if err != nil || items == nil || len(items) != 0 || next != nil {
		t.Fatal("empty page is not []/null")
	}
}

type historyHTTPStore struct {
	Store
	calls int
	page  HistoryPage
	after func()
}

func (s *historyHTTPStore) ConversationHistory(_ context.Context, manager, run, attempt string, cursor *string) (HistoryPage, error) {
	s.calls++
	if manager != "m9-manager" || run != s.page.RunID || attempt != s.page.AttemptID {
		return HistoryPage{}, ErrHistoryUnavailable
	}
	if s.after != nil {
		s.after()
	}
	return s.page, nil
}

func TestM9HistoryHTTP(t *testing.T) {
	store := &historyHTTPStore{page: HistoryPage{WorkspaceID: NewID(), RunID: NewID(), AttemptID: NewID(), ConversationID: NewID(), MaxSequence: "0", Items: []HistoryItem{}}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(store, log)
	engine.session = &Session{managerID: "m9-manager", liveEpoch: NewID(), ready: true, peer: &recordPeer{}}
	defer engine.Close()
	handler := NewAPI(store, nil, engine, "synthetic-token", log).Handler(nil)
	request := func(secure, auth bool, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://localhost/api/manager/runs/"+store.page.RunID+"/attempts/"+store.page.AttemptID+"/history", strings.NewReader(body))
		r.Header.Set("X-Forwarded-Proto", "https")
		if secure {
			r.TLS = &tls.ConnectionState{}
		}
		if auth {
			r.Header.Set("Authorization", "Bearer synthetic-token")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request(true, false, `{"cursor":null}`); w.Code != 401 {
		t.Fatal("Manager token not required")
	}
	if w := request(false, true, `{"cursor":null}`); w.Code != 400 || !strings.Contains(w.Body.String(), "protected_transport_required") {
		t.Fatal("plaintext/forwarded HTTPS accepted")
	}
	for _, body := range []string{`{}`, `null`, `{"cursor":1}`, `{"cursor":"x"}`, `{"cursor":null,"workspaceId":"other"}`, `{"cursor":null} {}`} {
		if w := request(true, true, body); w.Code != 400 {
			t.Fatalf("invalid body accepted: %s", body)
		}
	}
	if store.calls != 0 {
		t.Fatal("invalid request reached storage")
	}
	w := request(true, true, `{"cursor":null}`)
	var body map[string]json.RawMessage
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body) != 9 || string(body["items"]) != "[]" || string(body["testId"]) != "null" || string(body["editingSessionId"]) != "null" || string(body["nextCursor"]) != "null" {
		t.Fatalf("response shape/status: %d %s", w.Code, w.Body.String())
	}
	engine.session.ready = false
	if w := request(true, true, `{"cursor":null}`); w.Code != 409 || store.calls != 1 {
		t.Fatal("not-ready control allowed history")
	}
	engine.session.ready = true
	store.after = func() { engine.session.liveEpoch = NewID() }
	if w := request(true, true, `{"cursor":null}`); w.Code != 409 || strings.Contains(w.Body.String(), "items") {
		t.Fatal("response escaped after control epoch changed")
	}
}

func TestM9HistoryToolRouting(t *testing.T) {
	a := Assignment{Run: Run{Kind: "author"}, Author: &AuthorInput{AllowedTools: []string{"read_conversation_history"}}}
	if !offlineAuthorAllowed(a) || hasBrowserTools(a.Author) || !workspaceAuthorToolsValid(a.Author.AllowedTools) {
		t.Fatal("history-only task acquired browser requirements")
	}
	summary := editingAuthorInput(EditingSession{}, draftState{}, "acceptance-summary", []ChatMessage{})
	if summary.History != nil || len(summary.AllowedTools) != 0 {
		t.Fatal("summary acquired history tools")
	}
}
