//go:build integration

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestM11MCPRegistryReadScopeAndRevocation(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	a, err := p.CreateWorkspace(ctx, "M11 catalog A")
	if err != nil {
		t.Fatal(err)
	}
	b, err := p.CreateWorkspace(ctx, "M11 catalog B")
	if err != nil {
		t.Fatal(err)
	}
	version := m11PublishedModule(t, p, ctx, b.ID)
	ownedVersion := m11PublishedModule(t, p, ctx, a.ID)
	issued, secret, err := p.CreateAgentToken(ctx, a.ID, "reader")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	admin := NewID()
	handler := NewAPI(p, nil, nil, NewID(), log).WithAdminAccess(admin, "https://whippet.example").Handler(nil)
	post := func(origin, token, payload string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewBufferString(payload))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("Authorization", "Bearer "+token)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"m11-test","version":"1"}}}`
	if got := post("", secret, initialize).Code; got != http.StatusOK {
		t.Fatalf("initialize: %d", got)
	}
	tools := post("", secret, `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	if tools.Code != http.StatusOK {
		t.Fatalf("tools/list: %d", tools.Code)
	}
	var listed struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if json.Unmarshal(tools.Body.Bytes(), &listed) != nil {
		t.Fatal("invalid MCP tools/list response")
	}
	wantTools := []string{"author_start", "browser_click", "browser_fill", "browser_login", "browser_navigate", "browser_session_close", "browser_session_open", "browser_session_status", "browser_snapshot", "catalog_get", "catalog_search", "draft_create", "draft_get", "task_claim", "task_heartbeat", "task_submit", "task_tool_call", "validation_report", "validation_request"}
	if len(listed.Result.Tools) != len(wantTools) {
		t.Fatalf("MCP exposed %d tools; want exactly %d", len(listed.Result.Tools), len(wantTools))
	}
	for i, want := range wantTools {
		if listed.Result.Tools[i].Name != want {
			t.Fatalf("MCP tool %d = %q; want %q", i, listed.Result.Tools[i].Name, want)
		}
	}
	resources := post("", secret, `{"jsonrpc":"2.0","id":4,"method":"resources/list","params":{}}`)
	if resources.Code != http.StatusOK || !bytes.Contains(resources.Body.Bytes(), []byte("whippet://skill/catalog-reuse/main")) || !bytes.Contains(resources.Body.Bytes(), []byte("whippet://skill/catalog-reuse/references/selection")) {
		t.Fatal("packaged allowlisted skill resource was not listed")
	}
	readSkill := post("", secret, `{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"whippet://skill/catalog-reuse/main"}}`)
	if readSkill.Code != http.StatusOK || !bytes.Contains(readSkill.Body.Bytes(), []byte("Catalog reuse")) {
		t.Fatal("allowlisted skill main file was not readable")
	}
	readReference := post("", secret, `{"jsonrpc":"2.0","id":10,"method":"resources/read","params":{"uri":"whippet://skill/catalog-reuse/references/selection"}}`)
	if readReference.Code != http.StatusOK || !bytes.Contains(readReference.Body.Bytes(), []byte("selection")) {
		t.Fatal("allowlisted skill reference was not readable")
	}
	get := post("", secret, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"catalog_get","arguments":{"moduleVersionId":"`+version+`"}}}`)
	if get.Code != http.StatusOK || bytes.Contains(get.Body.Bytes(), []byte("fixture module content")) || bytes.Contains(get.Body.Bytes(), []byte(version)) {
		t.Fatal("cross-workspace Module was disclosed")
	}
	owned := post("", secret, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"catalog_get","arguments":{"moduleVersionId":"`+ownedVersion+`"}}}`)
	if owned.Code != http.StatusOK || !bytes.Contains(owned.Body.Bytes(), []byte("fixture module content")) || !bytes.Contains(owned.Body.Bytes(), []byte(`"structuredContent"`)) {
		t.Fatal("same-workspace published Module was not returned in structured and text form")
	}
	search := post("", secret, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"catalog_search","arguments":{"query":"Fixture","limit":20}}}`)
	if search.Code != http.StatusOK || !bytes.Contains(search.Body.Bytes(), []byte(ownedVersion)) || bytes.Contains(search.Body.Bytes(), []byte(version)) {
		t.Fatal("catalog search did not stay within token Workspace")
	}
	invalid := post("", secret, `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"catalog_search","arguments":{"query":"Fixture","limit":20,"cursor":"forbidden"}}}`)
	if invalid.Code != http.StatusOK || !bytes.Contains(invalid.Body.Bytes(), []byte(`"isError":true`)) {
		t.Fatal("registry rejected unknown catalog_search field incorrectly")
	}
	unknown := post("", secret, `{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"unlisted_tool_name","arguments":{}}}`)
	if unknown.Code != http.StatusOK || !bytes.Contains(unknown.Body.Bytes(), []byte(`"isError":true`)) || bytes.Contains(unknown.Body.Bytes(), []byte("unlisted_tool_name")) {
		t.Fatal("unlisted tool leaked its name or was accepted")
	}
	auditReq := httptest.NewRequest(http.MethodGet, "https://whippet.example/api/workspaces/"+a.ID+"/agent-tool-audit?limit=10", nil)
	auditReq.Header.Set("X-Whippet-Admin-Token", admin)
	audit := httptest.NewRecorder()
	handler.ServeHTTP(audit, auditReq)
	if audit.Code != http.StatusOK || !bytes.Contains(audit.Body.Bytes(), []byte(`"toolName":"catalog_get"`)) || !bytes.Contains(audit.Body.Bytes(), []byte(`"toolName":"unknown"`)) || !bytes.Contains(audit.Body.Bytes(), []byte(`"decision":"denied"`)) || bytes.Contains(audit.Body.Bytes(), []byte(secret)) || bytes.Contains(audit.Body.Bytes(), []byte(version)) {
		t.Fatal("scoped metadata-only tool audit missing or unsafe")
	}
	pageReq := httptest.NewRequest(http.MethodGet, "https://whippet.example/api/workspaces/"+a.ID+"/agent-tool-audit?limit=2", nil)
	pageReq.Header.Set("X-Whippet-Admin-Token", admin)
	firstPage := httptest.NewRecorder()
	handler.ServeHTTP(firstPage, pageReq)
	var page struct {
		Items      []AgentToolAudit `json:"items"`
		NextCursor *string          `json:"nextCursor"`
	}
	if firstPage.Code != http.StatusOK || json.Unmarshal(firstPage.Body.Bytes(), &page) != nil || len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatal("audit pagination did not issue a bounded cursor")
	}
	foreignCursor := httptest.NewRequest(http.MethodGet, "https://whippet.example/api/workspaces/"+b.ID+"/agent-tool-audit?before="+url.QueryEscape(*page.NextCursor), nil)
	foreignCursor.Header.Set("X-Whippet-Admin-Token", admin)
	foreignPage := httptest.NewRecorder()
	handler.ServeHTTP(foreignPage, foreignCursor)
	if foreignPage.Code != http.StatusBadRequest {
		t.Fatalf("audit cursor changed Workspace: %d", foreignPage.Code)
	}
	if got := post("https://evil.example", secret, initialize).Code; got != http.StatusForbidden {
		t.Fatalf("foreign Origin: %d", got)
	}
	if err := p.RevokeAgentToken(ctx, a.ID, issued.ID); err != nil {
		t.Fatal(err)
	}
	if got := post("", secret, initialize).Code; got != http.StatusUnauthorized {
		t.Fatalf("revoked token: %d", got)
	}
}

func m11PublishedModule(t *testing.T, p *Postgres, ctx context.Context, workspace string) string {
	t.Helper()
	slug := "fixture-module"
	item, err := p.CreatePlatformTest(ctx, workspace, "Fixture", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	version := NewID()
	module := &Module{Slug: slug, ModuleKind: "step", ExportName: "fixture", Signature: "fixture({page})", Harness: "test('fixture', async ({page}) => {});"}
	if _, err := p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,module,workspace_settings) VALUES($1,$2,1,'fixture module content',30000,$3,$4)`, version, item.ID, jsonText(module), `{}`); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, item.ID, version); err != nil {
		t.Fatal(err)
	}
	return version
}

func TestM11MCPRateLimitUsesTokenBucket(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "rate fixture")
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err := p.CreateAgentToken(ctx, w.ID, "rate")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(p, nil, nil, NewID(), log).WithAdminAccess(NewID(), "").Handler(nil)
	payload := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"m11-test","version":"1"}}}`
	for i := 0; i < 11; i++ {
		r := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewBufferString(payload))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("Authorization", "Bearer "+secret)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, r)
		if i < 10 && out.Code != http.StatusOK {
			t.Fatalf("burst request %d: %d", i, out.Code)
		}
		if i == 10 && (out.Code != http.StatusTooManyRequests || out.Header().Get("Retry-After") == "") {
			t.Fatalf("burst overflow: %d", out.Code)
		}
	}
	var limited int
	if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM agent_tool_audit WHERE workspace_id=$1 AND decision='rate_limited'`, w.ID).Scan(&limited); err != nil || limited != 1 {
		t.Fatal("rate limit audit missing", err)
	}
}

func TestM11MCPCatalogDBFailureCannotReturnSuccessNull(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "query failure fixture")
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err := p.CreateAgentToken(ctx, w.ID, "reader")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(p, nil, nil, NewID(), log).WithAdminAccess(NewID(), "").Handler(nil)
	// The disposable schema is intentionally broken after the MCP handler is ready.
	// Agent auth remains available, while the catalog query must fail closed.
	if _, err := p.DB.ExecContext(ctx, `DROP TABLE test_versions CASCADE`); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewBufferString(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"catalog_search","arguments":{"query":"x","limit":1}}}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("Authorization", "Bearer "+secret)
	out := httptest.NewRecorder()
	handler.ServeHTTP(out, r)
	if out.Code != http.StatusOK || !bytes.Contains(out.Body.Bytes(), []byte(`"isError":true`)) || bytes.Contains(out.Body.Bytes(), []byte(`"text":"null"`)) {
		t.Fatal("catalog DB failure returned success/null")
	}
	var decision string
	if err := p.DB.QueryRowContext(ctx, `SELECT decision FROM agent_tool_audit WHERE workspace_id=$1`, w.ID).Scan(&decision); err != nil || decision != "failed" {
		t.Fatal("catalog DB failure audit decision", err)
	}
}

func TestM11MCPRejectsDuplicateAndOversizedRawArguments(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "argument boundary fixture")
	if err != nil {
		t.Fatal(err)
	}
	_, secret, err := p.CreateAgentToken(ctx, w.ID, "reader")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(p, nil, nil, NewID(), log).WithAdminAccess(NewID(), "").Handler(nil)
	call := func(args string) *httptest.ResponseRecorder {
		t.Helper()
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"catalog_search","arguments":` + args + `}}`
		r := httptest.NewRequest(http.MethodPost, "https://whippet.example/mcp", bytes.NewBufferString(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("Authorization", "Bearer "+secret)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, r)
		return out
	}
	for _, args := range []string{`{"query":"x","limit":1,"limit":2}`, `{"query":"x","limit":1` + strings.Repeat(" ", 17<<10) + `}`} {
		out := call(args)
		if out.Code != http.StatusOK || !bytes.Contains(out.Body.Bytes(), []byte(`"isError":true`)) {
			t.Fatalf("unsafe raw arguments accepted: %d", out.Code)
		}
	}
	if out := call(`{"query":"x","limit":1` + strings.Repeat(" ", maxMCPHTTPBodyBytes+1) + `}`); out.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized MCP HTTP body: %d", out.Code)
	}
}
