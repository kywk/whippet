package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

type m11GateStore struct{ Store }

func (m11GateStore) Workspaces(context.Context) ([]Workspace, error) { return []Workspace{}, nil }

func TestM11AdminGateKeepsManagerAndHealthSeparate(t *testing.T) {
	admin := NewID()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := NewAPI(nil, nil, nil, NewID(), log).WithAdminAccess(admin, "https://whippet.example")
	handler := api.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	request := func(path, method, adminHeader, bearer string) int {
		t.Helper()
		r := httptest.NewRequest(method, "https://whippet.example"+path, nil)
		if adminHeader != "" {
			r.Header.Set("X-Whippet-Admin-Token", adminHeader)
		}
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w.Code
	}
	if got := request("/healthz", "GET", "", ""); got != http.StatusOK {
		t.Fatalf("health with enabled gate: %d", got)
	}
	if got := request("/api/dev-login", "POST", "", ""); got != http.StatusUnauthorized {
		t.Fatalf("public UI path without admin key: %d", got)
	}
	if got := request("/api/dev-login", "POST", NewID(), ""); got != http.StatusUnauthorized {
		t.Fatalf("wrong admin key: %d", got)
	}
	if got := request("/api/dev-login", "POST", admin, ""); got != http.StatusOK {
		t.Fatalf("admin key: %d", got)
	}
	if got := request("/api/dev-login", "POST", admin, "agent-token"); got != http.StatusForbidden {
		t.Fatalf("bearer reached UI despite admin key: %d", got)
	}
	if got := request("/api/manager/connect", "GET", "", api.token); got != http.StatusNoContent {
		t.Fatalf("manager path needs only manager bearer: %d", got)
	}
}

func TestM11MCPAndTokenManagementDisabledWithoutAdminKey(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(nil, nil, nil, NewID(), log).Handler(nil)
	for _, path := range []string{"/mcp", "/api/workspaces/" + NewID() + "/agent-tokens"} {
		r := httptest.NewRequest(http.MethodPost, "https://whippet.example"+path, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("%s without admin key: %d", path, w.Code)
		}
	}
}

func TestM11AdminCookieSupportsNativeGETAndLogout(t *testing.T) {
	admin := NewID()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(m11GateStore{}, nil, nil, NewID(), log).WithAdminAccess(admin, "https://whippet.example").Handler(nil)
	call := func(method, path, origin, adminHeader string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "https://whippet.example"+path, nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if adminHeader != "" {
			r.Header.Set("X-Whippet-Admin-Token", adminHeader)
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	login := call("POST", "/api/dev-login", "https://whippet.example", admin, nil)
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatalf("admin login did not issue cookie: %d", login.Code)
	}
	cookie := login.Result().Cookies()[0]
	if cookie.Value == "" || cookie.HttpOnly != true || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/api" || cookie.MaxAge < 1 || cookie.MaxAge > 8*60*60 || !cookie.Secure {
		t.Fatal("admin cookie attributes invalid")
	}
	if got := call("GET", "/api/workspaces", "", "", cookie).Code; got != http.StatusOK {
		t.Fatalf("native cookie GET: %d", got)
	}
	if got := call("GET", "/api/workspaces", "https://evil.example", "", cookie).Code; got != http.StatusForbidden {
		t.Fatalf("cross-origin cookie GET: %d", got)
	}
	if got := call("POST", "/api/workspaces", "", "", cookie).Code; got != http.StatusForbidden {
		t.Fatalf("cookie write without Origin: %d", got)
	}
	if got := call("POST", "/api/dev-login", "https://whippet.example", "", cookie).Code; got != http.StatusUnauthorized {
		t.Fatalf("cookie renewed login: %d", got)
	}
	logout := call("POST", "/api/dev-logout", "https://whippet.example", "", cookie)
	if logout.Code != http.StatusNoContent || len(logout.Result().Cookies()) == 0 || logout.Result().Cookies()[0].MaxAge >= 0 {
		t.Fatalf("logout did not clear cookie: %d", logout.Code)
	}
	if got := call("POST", "/api/dev-logout", "https://whippet.example", "", cookie).Code; got != http.StatusNoContent {
		t.Fatalf("replayed logout: %d", got)
	}
	if got := call("GET", "/api/workspaces", "", "", cookie).Code; got != http.StatusUnauthorized {
		t.Fatalf("revoked cookie GET: %d", got)
	}
}
