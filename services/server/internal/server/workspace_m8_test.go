package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func m8Config() WorkspaceConfig {
	return WorkspaceConfig{Name: "工作區", Purpose: "驗收", BackgroundSummary: "本機測試背景", TimeoutMS: 60000,
		Targets:        []WorkspaceOrigin{{Name: "網站", Origin: "https://example.test", Purpose: "測試"}},
		Dependencies:   []WorkspaceOrigin{{Name: "登入", Purpose: "login", Origin: "https://login.example.test"}},
		LoginRoles:     []WorkspaceRole{{Name: "測試角色", LoginMethod: "form", LoginOrigin: "https://login.example.test"}},
		DefaultTestURL: "https://example.test/start"}
}

func TestM8ConfigurationBoundaries(t *testing.T) {
	c := m8Config()
	c.Targets[0].Origin = "https://EXAMPLE.test:0443/"
	valid, err := normalizeConfig(c, true)
	if err != nil || valid.Targets[0].Origin != "https://example.test" {
		t.Fatalf("origin normalization: %+v %v", valid, err)
	}
	for _, change := range []func(*WorkspaceConfig){
		func(c *WorkspaceConfig) { c.Name = strings.Repeat("字", 67) },
		func(c *WorkspaceConfig) { c.BackgroundSummary = strings.Repeat("x", 8193) },
		func(c *WorkspaceConfig) {
			c.Targets = append(c.Targets, WorkspaceOrigin{Name: "重複", Origin: "https://EXAMPLE.test:443/"})
		},
		func(c *WorkspaceConfig) { c.Dependencies[0].Origin = "https://example.test/" },
		func(c *WorkspaceConfig) { c.Dependencies[0].Purpose = "arbitrary" },
		func(c *WorkspaceConfig) { c.ExcludedOrigins = []string{"https://EXAMPLE.test:443/"} },
		func(c *WorkspaceConfig) {
			c.ExcludedOrigins = []string{"https://other.test", "https://OTHER.test:443/"}
		},
		func(c *WorkspaceConfig) { c.LoginRoles[0].LoginOrigin = "https://unapproved.test" },
		func(c *WorkspaceConfig) { c.DefaultTestURL = "https://example.test.evil/start" },
		func(c *WorkspaceConfig) { c.Targets[0].Origin = "https://example.test/path" },
		func(c *WorkspaceConfig) { c.Targets[0].Origin = "https://*.example.test" },
		func(c *WorkspaceConfig) { c.Targets[0].Origin = "https://user:synthetic@example.test" },
		func(c *WorkspaceConfig) { c.Targets[0].Origin = "https://example.test?query=1" },
		func(c *WorkspaceConfig) { c.TimeoutMS = 0 },
	} {
		c := m8Config()
		change(&c)
		if _, err := normalizeConfig(c, false); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid config accepted: %+v %v", c, err)
		}
	}
	incomplete := WorkspaceConfig{Name: "訪談中", TimeoutMS: 60000}
	if _, err := normalizeConfig(incomplete, false); err != nil {
		t.Fatalf("incomplete interview proposal: %v", err)
	}
	if _, err := normalizeConfig(incomplete, true); !errors.Is(err, ErrInvalid) {
		t.Fatal("incomplete configuration confirmed")
	}
	for _, body := range []string{
		`{"message":"ok","requiredPolicyVersion":1}`, `{"message":"ok","mode":"workspace"}`,
		`{"message":"ok","proposal":{"name":"x","timeoutMs":60000,"secretRef":"synthetic"}}`,
		`{"message":"ok","proposal":{"name":"x","timeoutMs":60000,"env":{}}}`,
	} {
		if _, err := decodeWorkspaceAuthorOutput([]byte(body)); err == nil {
			t.Fatalf("unknown field accepted: %s", body)
		}
	}
}

func TestM8SecretVaultBinding(t *testing.T) {
	vault, err := NewSecretVault(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{17}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	values := credentialValues{"synthetic-user", "synthetic-password"}
	nonce, sealed, err := vault.seal("workspace", "role", "ref", 1, values)
	if err != nil || bytes.Contains(sealed, []byte(values.Password)) {
		t.Fatal("plaintext or failed seal")
	}
	opened, err := vault.open("workspace", "role", "ref", 1, nonce, sealed)
	if err != nil || opened != values {
		t.Fatal("synthetic AEAD round trip failed")
	}
	otherNonce, _, err := vault.seal("workspace", "role", "ref", 1, values)
	if err != nil || bytes.Equal(nonce, otherNonce) {
		t.Fatal("nonce reused")
	}
	for _, parts := range [][3]string{{"other", "role", "ref"}, {"workspace", "other", "ref"}, {"workspace", "role", "other"}} {
		if _, err := vault.open(parts[0], parts[1], parts[2], 1, nonce, sealed); err == nil {
			t.Fatal("cross-scope ciphertext accepted")
		}
	}
	if _, err := vault.open("workspace", "role", "ref", 2, nonce, sealed); err == nil {
		t.Fatal("old secret version accepted")
	}
	sealed[0] ^= 1
	if _, err := vault.open("workspace", "role", "ref", 1, nonce, sealed); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
	if v, err := NewSecretVault(""); v != nil || err != nil {
		t.Fatal("missing key must disable storage")
	}
	if _, err := NewSecretVault("invalid"); !errors.Is(err, ErrSecretsUnavailable) {
		t.Fatal("invalid key accepted")
	}
	if _, err := (&Postgres{}).SaveWorkspaceCredentials(context.Background(), NewID(), NewID(), 0, values); !errors.Is(err, ErrSecretsUnavailable) {
		t.Fatal("missing key did not fail closed")
	}
}

type m8HTTPStore struct {
	Store
	w          Workspace
	missingKey bool
	saved      int
}

func (s *m8HTTPStore) ResourceWorkspace(_ context.Context, _, id string) (string, error) {
	if id != s.w.ID {
		return "", ErrNotFound
	}
	return s.w.ID, nil
}
func (s *m8HTTPStore) Workspace(_ context.Context, _ string) (Workspace, error) { return s.w, nil }
func (s *m8HTTPStore) SaveWorkspaceCredentials(_ context.Context, _, role string, expected int, _ credentialValues) (RoleRef, error) {
	if s.missingKey {
		return RoleRef{}, ErrSecretsUnavailable
	}
	if expected != 0 {
		return RoleRef{}, ErrConflict
	}
	s.saved++
	v := 1
	return RoleRef{RoleID: role, SecretRef: stringPointer(NewID()), SecretVersion: &v, Configured: true}, nil
}

func TestM8CredentialHTTPAndOwner(t *testing.T) {
	store := &m8HTTPStore{w: Workspace{ID: NewID()}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(store, log)
	defer engine.Close()
	h := NewAPI(store, nil, engine, "test", log).Handler(nil)
	endpoint := "/api/workspaces/" + store.w.ID
	rolePath := endpoint + "/roles/" + NewID() + "/credentials"
	request := func(method, path, body string, secure bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
		r.RemoteAddr = "172.18.0.2:45678"
		r.Header.Set("X-Forwarded-Proto", "https")
		if secure {
			r.TLS = &tls.ConnectionState{}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	valid := `{"expectedSecretVersion":0,"username":"synthetic-user","password":"synthetic-password"}`
	if w := request("PUT", rolePath, valid, false); w.Code != 400 || !strings.Contains(w.Body.String(), "protected_transport_required") {
		t.Fatal("proxy HTTP incorrectly trusted")
	}
	for _, body := range []string{`{}`, `{"expectedSecretVersion":null}`, `{"expectedSecretVersion":-1}`, `{"expectedSecretVersion":1.5}`, `{"expectedSecretVersion":0,"env":{}}`} {
		if w := request("PUT", rolePath, body, true); w.Code != 400 {
			t.Fatalf("invalid credential lock accepted: %d %s", w.Code, w.Body)
		}
	}
	if store.saved != 0 {
		t.Fatal("invalid request reached storage")
	}
	w := request("PUT", rolePath, valid, true)
	var ref RoleRef
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &ref) != nil || !ref.Configured || ref.SecretVersion == nil || *ref.SecretVersion != 1 || strings.Contains(w.Body.String(), "synthetic-") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("credential response: %d %s", w.Code, w.Body)
	}
	store.missingKey = true
	if w := request("PUT", rolePath, valid, true); w.Code != 503 || !strings.Contains(w.Body.String(), "secrets_unavailable") {
		t.Fatal("missing-key response must be 503")
	}
	if w := request("GET", endpoint, "", true); w.Code != http.StatusOK {
		t.Fatal("owner-derived URL requires no query")
	}
	if w := request("GET", endpoint+"?workspaceId="+NewID(), "", true); w.Code != 404 {
		t.Fatal("mismatched scope accepted")
	}
	for _, tc := range []struct {
		host, remote string
		allowed      bool
	}{{"localhost:8080", "127.0.0.1:1234", true}, {"[::1]:8080", "[::1]:1234", true}, {"public.test", "127.0.0.1:1234", false}, {"localhost", "172.18.0.2:1234", false}} {
		r := httptest.NewRequest("PUT", "http://"+tc.host+"/", nil)
		r.RemoteAddr = tc.remote
		if protectedCredentialTransport(r) != tc.allowed {
			t.Fatalf("transport %s %s", tc.host, tc.remote)
		}
	}
}

func TestM8WorkspaceDispatchAndExecutionGate(t *testing.T) {
	w := Workspace{ID: NewID(), Roles: []RoleRef{}, WorkspaceSettings: WorkspaceSettings{Revision: 1, Sites: []WorkspaceSite{}, TimeoutMS: 60000}}
	a := Assignment{Run: Run{ID: NewID(), WorkspaceID: w.ID, Kind: "author", WorkspaceContext: workspaceContext(w), WorkspaceSettings: &w.WorkspaceSettings}, AttemptID: NewID(), Author: &AuthorInput{SkillID: "workspace-author", SkillVersion: "1", AllowedTools: []string{}, Messages: []ChatMessage{{Role: "user", Content: "訪談"}}}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	peer := &recordPeer{}
	if err := NewEngine(nil, log).send(&Session{peer: peer, sent: map[string]time.Time{}}, a, "dispatch"); err != nil {
		t.Fatal(err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(peer.messages[0].Payload, &wire); err != nil {
		t.Fatal(err)
	}
	var author map[string]json.RawMessage
	if json.Unmarshal(wire["author"], &author) != nil || string(wire["scriptOrigin"]) != `"legacy"` || string(wire["testId"]) != "null" || string(author["editingSessionId"]) != "null" || string(author["allowedTools"]) != "[]" || wire["workspaceContext"] == nil || wire["workspaceId"] == nil {
		t.Fatalf("wire shape: %s", peer.messages[0].Payload)
	}
	for _, forbidden := range []string{"requiredPolicyVersion", "workspaceSnapshot", "owner", "mode", "password"} {
		if bytes.Contains(peer.messages[0].Payload, []byte(`"`+forbidden+`"`)) {
			t.Fatalf("unexpected wire field %s", forbidden)
		}
	}
	if !offlineAuthorAllowed(a) {
		t.Fatal("A availability gate")
	}
	a.Author.SkillID = "test-author"
	a.Author.AllowedTools = []string{"read_draft", "read_validation_report", "update_draft"}
	if !offlineAuthorAllowed(a) {
		t.Fatal("safe editing tools rejected")
	}
	a.Author.AllowedTools = append(a.Author.AllowedTools, "request_validation")
	if offlineAuthorAllowed(a) {
		t.Fatal("network validation tool allowed")
	}
	a.Kind = "run"
	if offlineAuthorAllowed(a) {
		t.Fatal("arbitrary script execution allowed")
	}
}
