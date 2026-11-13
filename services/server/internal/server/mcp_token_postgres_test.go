//go:build integration

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestM11AgentTokenLifecycleHTTP(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	a, err := p.CreateWorkspace(ctx, "M11 A")
	if err != nil {
		t.Fatal(err)
	}
	b, err := p.CreateWorkspace(ctx, "M11 B")
	if err != nil {
		t.Fatal(err)
	}
	admin := NewID()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(p, nil, nil, NewID(), log).WithAdminAccess(admin, "https://whippet.example").Handler(nil)
	call := func(method, path string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "https://whippet.example"+path, bytes.NewReader(body))
		r.Header.Set("X-Whippet-Admin-Token", admin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	base := "/api/workspaces/" + a.ID + "/agent-tokens"
	created := call(http.MethodPost, base, []byte(`{"name":"  Agent One  "}`))
	if created.Code != http.StatusCreated || created.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("create token status/cache: %d/%q", created.Code, created.Header().Get("Cache-Control"))
	}
	var issued struct {
		Token      string     `json:"token"`
		AgentToken AgentToken `json:"agentToken"`
	}
	if json.Unmarshal(created.Body.Bytes(), &issued) != nil || len(issued.Token) < 40 || issued.AgentToken.WorkspaceID != a.ID || issued.AgentToken.Name != "Agent One" {
		t.Fatal("create response lacks one-time token and scoped metadata")
	}
	listed := call(http.MethodGet, base, nil)
	if listed.Code != http.StatusOK || bytes.Contains(listed.Body.Bytes(), []byte(issued.Token)) || bytes.Contains(listed.Body.Bytes(), []byte(`"token"`)) {
		t.Fatal("token list leaked plaintext or failed")
	}
	wrongWorkspace := call(http.MethodDelete, "/api/workspaces/"+b.ID+"/agent-tokens/"+issued.AgentToken.ID, nil)
	if wrongWorkspace.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace revoke: %d", wrongWorkspace.Code)
	}
	for i := 0; i < 2; i++ {
		if got := call(http.MethodDelete, base+"/"+issued.AgentToken.ID, nil).Code; got != http.StatusNoContent {
			t.Fatalf("revoke %d: %d", i, got)
		}
	}
	var digest []byte
	if err := p.DB.QueryRowContext(ctx, `SELECT token_hash FROM agent_tokens WHERE id=$1`, issued.AgentToken.ID).Scan(&digest); err != nil || len(digest) != 32 || bytes.Equal(digest, []byte(issued.Token)) {
		t.Fatal("token digest was not stored as SHA-256")
	}
}
