//go:build integration

package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublishedVersionConversationHTTP(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	const testID = "10000000-0000-4000-8000-000000000001"
	const foreignTestID = "10000000-0000-4000-8000-000000000002"
	const legacyVersionID = "20000000-0000-4000-8000-000000000001"
	session, _, err := p.StartEditingSession(ctx, testID)
	if err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := p.DB.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < versionConversationPageSize; i++ {
		historyInsert(t, p, ctx, session.ConversationID, fmt.Sprintf("訊息 %d", i))
	}
	exec(`INSERT INTO messages(id,conversation_id,role,content,base_revision,proposed_script)
 VALUES($1,$2,'assistant','末則回覆',1,'internal candidate')`, NewID(), session.ConversationID)
	versionID := NewID()
	exec(`INSERT INTO test_versions(id,test_id,version,source_revision,script,script_hash,timeout_ms,workspace_settings,editing_session_id,script_origin)
 SELECT $1,test_id,2,revision,script,script_hash,timeout_ms,workspace_settings,$2,'ai' FROM draft_revisions WHERE test_id=$3 AND revision=$4`,
		versionID, session.ID, testID, session.Draft.Revision)

	const adminToken = "synthetic-version-history-admin"
	handler := NewAPI(p, nil, nil, "unused-manager-token", slog.Default()).WithAdminAccess(adminToken, "").Handler(http.NotFoundHandler())
	urlFor := func(test, version string) string {
		return "/api/tests/" + test + "/versions/" + version + "/conversation"
	}
	get := func(url string, status int, authorized bool) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, url, nil)
		if authorized {
			request.Header.Set("X-Whippet-Admin-Token", adminToken)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("GET %s: got %d, want %d", url, response.Code, status)
		}
		return response
	}
	url := urlFor(testID, versionID)
	get(url, http.StatusNotFound, true)
	exec(`UPDATE editing_sessions SET status='published',published_version_id=$1,closed_at=now() WHERE id=$2`, versionID, session.ID)
	exec(`UPDATE tests SET published_version_id=$1 WHERE id=$2`, versionID, testID)
	exec(`DELETE FROM drafts WHERE test_id=$1 AND editing_session_id=$2`, testID, session.ID)
	if _, err := p.CreateAuthor(ctx, testID, session.ID, "發佈後的訊息", session.Draft.Revision); !errors.Is(err, ErrConflict) {
		t.Fatalf("published conversation allowed a new turn: %v", err)
	}
	active, _, err := p.StartEditingSession(ctx, testID)
	if err != nil {
		t.Fatal(err)
	}
	historyInsert(t, p, ctx, active.ConversationID, "新草稿的訊息")
	get(url, http.StatusUnauthorized, false)
	get(urlFor(foreignTestID, versionID), http.StatusNotFound, true)
	get(urlFor(testID, legacyVersionID), http.StatusNotFound, true)
	get(url+"?workspaceId="+NewID(), http.StatusNotFound, true)
	get(url+"?after=-1", http.StatusBadRequest, true)
	first := get(url, http.StatusOK, true)
	var page VersionConversationPage
	if first.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(first.Body.Bytes(), &page) != nil ||
		page.VersionID != versionID || page.TestID != testID || page.NextCursor == nil || len(page.Messages) != versionConversationPageSize || page.Messages[0].Content != "訊息 0" {
		t.Fatal("invalid first page of published conversation")
	}
	last := get(url+"?after="+*page.NextCursor, http.StatusOK, true)
	if json.Unmarshal(last.Body.Bytes(), &page) != nil || page.NextCursor != nil || len(page.Messages) != 1 || page.Messages[0].Role != "assistant" || page.Messages[0].Content != "末則回覆" {
		t.Fatal("invalid last page of published conversation")
	}
	var projected struct{ Messages []map[string]any }
	if json.Unmarshal(last.Body.Bytes(), &projected) != nil || len(projected.Messages[0]) != 4 {
		t.Fatal("version conversation exposed internal authoring fields")
	}
}
