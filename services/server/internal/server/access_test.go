package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const fixtureAdminKey = "whippet-test-admin-key"
const fixtureOrigin = "https://whippet.example"

func TestDevelopmentLoginWithAndWithoutManagementKey(t *testing.T) {
	for _, fixture := range []struct{ name, key string }{{"local", ""}, {"with_key", fixtureAdminKey}} {
		t.Run(fixture.name, func(t *testing.T) {
			key := fixture.key
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			handler := NewAPI(m11GateStore{}, nil, nil, "fixture-manager", log).WithAdminAccess(key, fixtureOrigin).Handler(nil)
			call := func(method, path, body, adminKey, origin string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(body))
				if adminKey != "" {
					r.Header.Set("X-Whippet-Admin-Token", adminKey)
				}
				if origin != "" {
					r.Header.Set("Origin", origin)
				}
				for _, cookie := range cookies {
					r.AddCookie(cookie)
				}
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w
			}
			check := func(response *httptest.ResponseRecorder, want int) {
				t.Helper()
				if response.Code != want {
					t.Fatalf("got %d want %d: %s", response.Code, want, response.Body)
				}
			}
			check(call("GET", "/api/me", "", "", ""), 401)
			check(call("POST", "/api/workspaces", "{}", "", fixtureOrigin), 401)
			check(call("POST", "/api/dev-login", `{"userId":"dev-qa"}`, key, "https://other.example"), 403)
			check(call("POST", "/api/dev-login", `{"userId":"dev-qa","role":"superadmin"}`, key, fixtureOrigin), 400)
			check(call("POST", "/api/dev-login", `{"userId":"dev-qa","userId":"dev-admin"}`, key, fixtureOrigin), 400)
			check(call("POST", "/api/dev-login", `{"userId":"someone-else"}`, key, fixtureOrigin), 404)
			qaLogin := call("POST", "/api/dev-login", `{"userId":"dev-qa"}`, key, fixtureOrigin)
			check(qaLogin, 200)
			qaCookies := qaLogin.Result().Cookies()
			if len(qaCookies) != 1 || !qaCookies[0].HttpOnly || !qaCookies[0].Secure || qaCookies[0].SameSite != http.SameSiteStrictMode {
				t.Fatal("missing or invalid login cookie")
			}
			me := call("GET", "/api/me", "", key, "", qaCookies[0])
			check(me, 200)
			var data struct {
				User platformUser `json:"user"`
			}
			if err := json.Unmarshal(me.Body.Bytes(), &data); err != nil || data.User.ID != developmentQA || data.User.Role != noSiteRole || data.User.Permissions.ManageUsers {
				t.Fatalf("current identity did not come from the cookie: %s", me.Body)
			}
			check(call("POST", "/api/workspaces", "{}", key, fixtureOrigin, qaCookies[0]), 403)
			check(call("PATCH", "/api/users/dev-admin/role", `{"role":"none"}`, key, "", qaCookies[0]), 403)
			check(call("GET", "/api/me", "", key, "", &http.Cookie{Name: adminCookieName, Value: "invalid"}), 401)
			check(call("GET", "/api/me", "", key, "", qaCookies[0], qaCookies[0]), 401)

			adminLogin := call("POST", "/api/dev-login", "", key, fixtureOrigin, qaCookies[0])
			check(adminLogin, 200)
			check(call("GET", "/api/me", "", key, "", qaCookies[0]), 401)
			adminCookie := adminLogin.Result().Cookies()[0]
			check(call("GET", "/api/me", "", "", "", adminCookie), 200)
			check(call("POST", "/api/dev-logout", "", "", fixtureOrigin, adminCookie), 204)
			check(call("GET", "/api/me", "", key, "", adminCookie), 401)
		})
	}
}
