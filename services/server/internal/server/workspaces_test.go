package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWorkspacePatchValidatesAndKeepsNoOpRevision(t *testing.T) {
	current := WorkspaceSettings{Revision: 3, Sites: []WorkspaceSite{{Name: "網站", URL: "http://localhost:18080/"}}, TimeoutMS: 12345}
	var patch WorkspacePatch
	if err := json.Unmarshal([]byte(`{"revision":3,"sites":[{"name":" 網站 ","url":"http://localhost:18080/"}],"timeoutMs":12345}`), &patch); err != nil {
		t.Fatal(err)
	}
	next, changed, err := applyWorkspacePatch(current, patch)
	if err != nil || changed || !sameWorkspaceSettings(&next, &current) {
		t.Fatalf("no-op changed settings/revision: %+v %v %v", next, changed, err)
	}
	url := "https://example.test/new?view=test#form"
	next, changed, err = applyWorkspacePatch(current, WorkspacePatch{Revision: 3, DefaultTestURL: &url})
	if err != nil || !changed || next.Revision != 4 || next.TimeoutMS != 12345 || next.DefaultTestURL != url {
		t.Fatalf("partial update lost previous settings: %+v %v %v", next, changed, err)
	}
	if current.DefaultTestURL != "" || current.Revision != 3 || current.Sites[0].Name != "網站" {
		t.Fatal("updating settings mutated the original snapshot")
	}
	if _, _, err := applyWorkspacePatch(current, WorkspacePatch{Revision: 2}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision accepted: %v", err)
	}
	for _, raw := range []string{
		`{"revision":3,"timeoutMs":0}`, `{"revision":3,"timeoutMs":3600001}`,
		`{"revision":3,"defaultTestUrl":"file:///tmp/spec"}`,
		`{"revision":3,"defaultTestUrl":"https://user:password@example.test/"}`,
		`{"revision":3,"sites":[{"name":" ","url":"https://example.test/"}]}`,
	} {
		if err := json.Unmarshal([]byte(raw), &patch); err != nil {
			t.Fatal(err)
		}
		if _, _, err := applyWorkspacePatch(current, patch); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid settings accepted: %s %v", raw, err)
		}
		patch = WorkspacePatch{}
	}
	sites := make([]WorkspaceSite, 21)
	if _, _, err := applyWorkspacePatch(current, WorkspacePatch{Revision: 3, Sites: &sites}); !errors.Is(err, ErrInvalid) {
		t.Fatal("more than 20 sites accepted")
	}
}

func TestWorkspaceWebsiteURLBoundaries(t *testing.T) {
	for _, raw := range []string{"https://example.test/path", "http://127.0.0.1:18080/", "http://[::1]:18080/", "https://測試.example/路徑"} {
		if !validWebsiteURL(raw) {
			t.Fatalf("valid URL rejected: %q", raw)
		}
	}
	for _, raw := range []string{"", "/relative", "https:opaque", "https:///path", "https://user@example.test/", "javascript:alert(1)", "https://example.test/a b", "https://example.test/\n", "https://example.test:99999/", "https://example.test:/", "https://example.test/" + strings.Repeat("a", 2048)} {
		if validWebsiteURL(raw) {
			t.Fatalf("invalid URL accepted: %q", raw)
		}
	}
}

type workspaceHTTPStore struct {
	Store
	w Workspace
}

func (s *workspaceHTTPStore) Workspace(_ context.Context, id string) (Workspace, error) {
	if id != s.w.ID {
		return Workspace{}, ErrNotFound
	}
	return s.w, nil
}

func (s *workspaceHTTPStore) PatchWorkspace(ctx context.Context, id string, patch WorkspacePatch) (Workspace, error) {
	w, err := s.Workspace(ctx, id)
	if err != nil {
		return w, err
	}
	w.WorkspaceSettings, _, err = applyWorkspacePatch(w.WorkspaceSettings, patch)
	if err == nil {
		s.w = w
	}
	return w, err
}

func TestWorkspaceHTTPRejectsSecretUnknownAndNullFields(t *testing.T) {
	store := &workspaceHTTPStore{w: Workspace{ID: NewID(), Name: "Default", WorkspaceSettings: WorkspaceSettings{Revision: 1, Sites: []WorkspaceSite{}, TimeoutMS: 60000}}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(store, nil, NewEngine(store, log), "test", log).Handler(nil)
	request := func(method, id, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/api/workspaces/"+id, strings.NewReader(body))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, body := range []string{
		`{"revision":1,"env":{"TOKEN":"sensitive-sentinel"}}`,
		`{"revision":1,"secrets":{"key":"sensitive-sentinel"}}`,
		`{"revision":1,"name":"unsupported"}`, `{"revision":1,"key":"sensitive-sentinel"}`,
		`{"revision":1,"sites":[{"name":"test","url":"https://example.test/","key":"sensitive-sentinel"}]}`,
		`{"revision":1,"sites":null}`, `{"revision":1,"defaultTestUrl":null}`, `{"revision":1,"timeoutMs":null}`,
		`{"revision":1,"timeoutMs":1.5}`, `{"revision":0}`, `{}`, `null`, `{"revision":1} {}`,
		`{"revision":1,"defaultTestUrl":"https://user:sensitive-sentinel@example.test/"}`,
	} {
		w := request("PATCH", store.w.ID, body)
		if w.Code != 400 || strings.Contains(w.Body.String(), "sensitive-sentinel") {
			t.Fatalf("expected safe 400: %d %s", w.Code, w.Body)
		}
	}
	for _, tc := range []struct {
		method, body string
		status       int
	}{
		{"GET", "", 200}, {"PATCH", `{"revision":1}`, 200},
		{"PATCH", `{"revision":1,"timeoutMs":23456}`, 200},
		{"PATCH", `{"revision":1,"timeoutMs":34567}`, 409},
		{"GET", "", 200},
	} {
		w := request(tc.method, store.w.ID, tc.body)
		if w.Code != tc.status {
			t.Fatalf("%s: expected %d, got %d %s", tc.method, tc.status, w.Code, w.Body)
		}
	}
	if store.w.Revision != 2 || store.w.TimeoutMS != 23456 {
		t.Fatalf("stale PATCH overwrote settings: %+v", store.w)
	}
	if w := request("GET", NewID(), ""); w.Code != 404 {
		t.Fatal("unknown Workspace must be 404")
	}
}

func TestWorkspaceDispatchCarriesImmutableAuthorAndRunSnapshot(t *testing.T) {
	settings := &WorkspaceSettings{Revision: 4, Sites: []WorkspaceSite{{Name: "固定網站", URL: "http://example.test/"}}, DefaultTestURL: "http://example.test/start", TimeoutMS: 23456}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(nil, log)
	for _, kind := range []string{"run", "validation", "author"} {
		peer := &recordPeer{}
		session := &Session{managerID: "manager-test", peer: peer, sent: map[string]time.Time{}}
		a := Assignment{Run: Run{ID: NewID(), Kind: kind, WorkspaceSettings: settings}, AttemptID: NewID(), Script: "fixed script", TimeoutMS: settings.TimeoutMS}
		if kind == "author" {
			a.TimeoutMS = authorTimeoutMS
			a.Author = &AuthorInput{ConversationID: NewID(), BaseRevision: 1, Messages: []ChatMessage{{Role: "user", Content: "test"}}}
		}
		if err := engine.send(session, a, "dispatch"); err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Kind              string             `json:"kind"`
			TimeoutMS         int                `json:"timeoutMs"`
			WorkspaceSettings *WorkspaceSettings `json:"workspaceSettings"`
		}
		if err := json.Unmarshal(peer.messages[0].Payload, &payload); err != nil || !sameWorkspaceSettings(settings, payload.WorkspaceSettings) || payload.TimeoutMS != a.TimeoutMS {
			t.Fatalf("%s snapshot lost: %+v %v", kind, payload, err)
		}
		settingsCopy := *settings
		settingsCopy.Revision++
		settingsCopy.DefaultTestURL = "http://changed.example.test/"
		if sameWorkspaceSettings(&settingsCopy, payload.WorkspaceSettings) {
			t.Fatal("queued payload changed with Workspace")
		}
	}
}
