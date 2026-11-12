//go:build integration

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
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// Exercise the real API, Engine session and PostgreSQL together. The original
// M9 tests checked HTTP and persistence separately, missing this call-site seam.
func TestM9HistoryRealHandlerCancelledFixture(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "handler fixture")
	if err != nil {
		t.Fatal(err)
	}
	test, err := p.CreateTest(ctx, w.ID, "handler fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	defer engine.Close()
	session, err := engine.Attach(ctx, "m9-handler", 1, &recordPeer{})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(ctx, session, NewEnvelope("heartbeat", "m9-handler", "", "", struct {
		Active []ActiveAttempt `json:"active"`
	}{[]ActiveAttempt{}})); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 12; n++ {
		content := "short filler " + strconv.Itoa(n)
		if n == 0 {
			content = "M9-handler-synthetic-marker"
		}
		submitted, err := p.CreateAuthor(ctx, test.ID, s.ID, content, s.Draft.Revision)
		if err != nil {
			t.Fatal(err)
		}
		if r, err := p.Cancel(ctx, submitted.Run.ID); err != nil || r.Status != "cancelled" {
			t.Fatal("queued fixture cancellation", err)
		}
	}
	submitted, err := p.CreateAuthor(ctx, test.ID, s.ID, "read the earliest decision", s.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	assignments, err := p.Assignments(ctx, "m9-handler")
	if err != nil || len(assignments) != 1 || assignments[0].ID != submitted.Run.ID || assignments[0].Author.ContextRevision != 13 {
		t.Fatal("dispatch fixture context", err)
	}
	a := assignments[0]
	if err := engine.Handle(ctx, session, NewEnvelope("event", "m9-handler", a.ID, a.AttemptID, Event{NewID(), "started", "Worker container starting"})); err != nil {
		t.Fatal(err)
	}
	handler := NewAPI(p, nil, engine, "synthetic-m9-token", log).Handler(nil)
	var cursor *string
	found := false
	for n := 0; n < 2; n++ {
		r := httptest.NewRequest("POST", "https://server/api/manager/runs/"+a.ID+"/attempts/"+a.AttemptID+"/history", strings.NewReader(jsonText(struct {
			Cursor *string `json:"cursor"`
		}{cursor})))
		r.TLS = &tls.ConnectionState{}
		r.Header.Set("Authorization", "Bearer synthetic-m9-token")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		var page HistoryPage
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(response.Body.Bytes(), &page) != nil || page.MaxSequence != a.Author.History.MaxSequence || len(page.Items) != 6 {
			t.Fatalf("real handler page %d status=%d body=%s", n, response.Code, response.Body.String())
		}
		for _, item := range page.Items {
			found = found || item.Content == "M9-handler-synthetic-marker"
		}
		cursor = page.NextCursor
	}
	if !found || cursor != nil {
		t.Fatal("real handler failed to recover the marker in two pages")
	}
}

func historyInsert(t *testing.T, p *Postgres, ctx context.Context, conversation, content string) int64 {
	t.Helper()
	var seq int64
	if err := p.DB.QueryRowContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,proposed_script)
 VALUES($1,$2,'user',$3,'private proposed script') RETURNING sequence`, NewID(), conversation, content).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return seq
}

func TestM9HistoryOwnersAndCutoff(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "M9 history")
	if err != nil {
		t.Fatal(err)
	}
	other, err := p.CreateWorkspace(ctx, "M9 other")
	if err != nil {
		t.Fatal(err)
	}
	test, err := p.CreateTest(ctx, w.ID, "history", "")
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	foreignTest, err := p.CreateTest(ctx, w.ID, "other session", "")
	if err != nil {
		t.Fatal(err)
	}
	foreignSession, _, err := p.StartEditingSession(ctx, foreignTest.ID)
	if err != nil {
		t.Fatal(err)
	}
	first := historyInsert(t, p, ctx, s.ConversationID, "old decision outside recent window")
	foreignSeq := historyInsert(t, p, ctx, foreignSession.ConversationID, "foreign session must stay hidden")
	foreignWorkspaceSeq := historyInsert(t, p, ctx, other.ConversationID, "foreign workspace must stay hidden")
	for n := 0; n < 13; n++ {
		historyInsert(t, p, ctx, s.ConversationID, "recent "+strconv.Itoa(n))
	}
	long := strings.Repeat("台🙂", 1800)
	last := historyInsert(t, p, ctx, s.ConversationID, long)
	submitted, err := p.CreateAuthor(ctx, test.ID, s.ID, "current turn excluded from history", s.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	const manager = "m9-history"
	if err := p.RegisterManager(ctx, manager, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ConversationHistory(ctx, manager, submitted.Run.ID, NewID(), nil); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("queued run read history", err)
	}
	a, err := p.Claim(ctx, manager, 1)
	if err != nil || a == nil || a.ID != submitted.Run.ID || a.Author.History == nil || a.Author.History.MaxSequence != strconv.FormatInt(last, 10) || !containsHistoryTool(a.Author.AllowedTools) || !offlineAuthorAllowed(*a) {
		t.Fatal("test author cutoff/routing", err)
	}
	for _, m := range a.Author.Messages {
		if strings.Contains(m.Content, "old decision") {
			t.Fatal("full history was eagerly sent")
		}
	}
	late := historyInsert(t, p, ctx, s.ConversationID, "late message must stay hidden")
	var cursor *string
	contents := map[string]string{}
	for n := 0; n < 4; n++ {
		page, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, cursor)
		if err != nil || page.WorkspaceID != w.ID || stringValue(page.TestID) != test.ID || stringValue(page.EditingSessionID) != s.ID || page.ConversationID != s.ConversationID || page.MaxSequence != strconv.FormatInt(last, 10) || len(page.Items) > 6 {
			t.Fatalf("bound page: %+v %v", page, err)
		}
		size := 0
		for _, item := range page.Items {
			contents[item.Sequence] += item.Content
			size += len(item.Content)
		}
		data, _ := json.Marshal(page)
		if size > 8192 || bytes.Contains(data, []byte("private proposed script")) || bytes.Contains(data, []byte("current turn")) || bytes.Contains(data, []byte("late message")) || bytes.Contains(data, []byte("foreign")) {
			t.Fatal("history exceeded its data/size boundary")
		}
		cursor = page.NextCursor
		if cursor == nil {
			break
		}
	}
	if cursor != nil || contents[strconv.FormatInt(first, 10)] != "old decision outside recent window" || contents[strconv.FormatInt(last, 10)] != long {
		t.Fatal("bounded pagination lost old decision or UTF-8 content")
	}
	for _, seq := range []int64{foreignSeq, foreignWorkspaceSeq} {
		page, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, historyPosition(seq, 0))
		if err != nil || len(page.Items) != 1 || page.Items[0].Sequence != strconv.FormatInt(first, 10) {
			t.Fatal("foreign cursor widened scope", err)
		}
		if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, historyPosition(seq, 1)); !errors.Is(err, ErrInvalid) {
			t.Fatal("offset entered foreign sequence", err)
		}
	}
	for _, cursor := range []*string{historyPosition(late, 0), historyPosition(last, 1), historyPosition(last, int64(len(long)+1))} {
		if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, cursor); !errors.Is(err, ErrInvalid) {
			t.Fatal("future/misaligned/outside cursor accepted", err)
		}
	}
	for _, identity := range [][2]string{{"wrong", a.AttemptID}, {manager, NewID()}} {
		if _, err := p.ConversationHistory(ctx, identity[0], a.ID, identity[1], nil); !errors.Is(err, ErrHistoryUnavailable) {
			t.Fatal("wrong Manager/attempt read history", err)
		}
	}
	for _, status := range []string{"collecting", "cancelling", "cancelled", "succeeded", "failed", "interrupted", "timed_out"} {
		if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status=$2 WHERE id=$1`, a.ID, status); err != nil {
			t.Fatal(err)
		}
		if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil); !errors.Is(err, ErrHistoryUnavailable) {
			t.Fatalf("%s read history: %v", status, err)
		}
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='running' WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET slot_released=true WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("released slot read history", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET slot_released=false WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"discarding", "discarded", "published"} {
		if _, err := p.DB.ExecContext(ctx, `UPDATE editing_sessions SET status=$2 WHERE id=$1`, s.ID, status); err != nil {
			t.Fatal(err)
		}
		if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil); !errors.Is(err, ErrHistoryUnavailable) {
			t.Fatal("closed session read history", err)
		}
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE editing_sessions SET status='active',context_revision=context_revision+1 WHERE id=$1`, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("stale context read history", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE editing_sessions SET context_revision=context_revision-1 WHERE id=$1`, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.SaveDraft(ctx, test.ID, s.ID, s.Draft.Revision, "new manual script"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("stale draft read history", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelled',slot_released=true WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	input := *a.Author
	input.SkillID = "acceptance-summary"
	summary, summaryAttempt := NewID(), NewID()
	if _, err := p.DB.ExecContext(ctx, `INSERT INTO runs(id,workspace_id,test_id,kind,draft_revision,editing_session_id,script_snapshot,script_hash,timeout_ms,author_payload,workspace_settings,workspace_context,status,manager_id,attempt_id,slot_released)
 SELECT $1,workspace_id,test_id,'author',draft_revision,editing_session_id,script_snapshot,script_hash,timeout_ms,$2,workspace_settings,workspace_context,'running',manager_id,$3,false FROM runs WHERE id=$4`, summary, jsonText(input), summaryAttempt, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ConversationHistory(ctx, manager, summary, summaryAttempt, nil); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("summary obtained history even with a forged allowed tool", err)
	}
}

func TestM9WorkspaceHistoryAndLegacyDenial(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "M9 workspace history")
	if err != nil {
		t.Fatal(err)
	}
	const manager = "m9-workspace"
	if err := p.RegisterManager(ctx, manager, 1); err != nil {
		t.Fatal(err)
	}
	s, err := p.CreateWorkspaceAuthor(ctx, w.ID, "first turn", w.Revision, 0)
	if err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, manager, 1)
	if err != nil || a == nil || a.ID != s.Run.ID || a.Author.History == nil || a.Author.History.MaxSequence != "0" || !workspaceAuthorToolsValid(a.Author.AllowedTools) {
		t.Fatal("empty Workspace cutoff", err)
	}
	page, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil)
	if err != nil || page.TestID != nil || page.EditingSessionID != nil || page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatal("workspace owner/empty page", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelled',slot_released=true WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	old := historyInsert(t, p, ctx, w.ConversationID, "old workspace decision")
	s, err = p.CreateWorkspaceAuthor(ctx, w.ID, "follow-up", w.Revision, 1)
	if err != nil {
		t.Fatal(err)
	}
	a, err = p.Claim(ctx, manager, 1)
	if err != nil || a == nil || a.ID != s.Run.ID || a.Author.History.MaxSequence != strconv.FormatInt(old, 10) {
		t.Fatal("follow-up bound", err)
	}
	page, err = p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil)
	if err != nil || len(page.Items) != 2 || page.Items[0].Content != "old workspace decision" || page.Items[1].Content != "first turn" {
		t.Fatal("Workspace history contents", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE conversations SET context_revision=context_revision+1 WHERE id=$1`, w.ConversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("Workspace stale context read history", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE conversations SET context_revision=context_revision-1 WHERE id=$1`, w.ConversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE workspaces SET settings=jsonb_set(settings,'{revision}',to_jsonb($2::integer)) WHERE id=$1`, w.ID, w.Revision+1); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ConversationHistory(ctx, manager, a.ID, a.AttemptID, nil); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("Workspace stale revision read history", err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE workspaces SET settings=jsonb_set(settings,'{revision}',to_jsonb($2::integer)) WHERE id=$1`, w.ID, w.Revision); err != nil {
		t.Fatal(err)
	}
	foreign, err := p.CreateWorkspace(ctx, "foreign history owner")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelled',slot_released=true WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*AuthorInput){
		func(input *AuthorInput) { input.History = nil },
		func(input *AuthorInput) { input.ConversationID = foreign.ConversationID },
		func(input *AuthorInput) { input.AllowedTools = []string{} },
	} {
		input := *a.Author
		mutate(&input)
		id, attempt := NewID(), NewID()
		_, err = p.DB.ExecContext(ctx, `INSERT INTO runs(id,workspace_id,kind,script_snapshot,script_hash,timeout_ms,author_payload,workspace_settings,workspace_context,status,manager_id,attempt_id,slot_released)
 SELECT $1,workspace_id,'author',script_snapshot,script_hash,timeout_ms,$2,workspace_settings,workspace_context,'running',manager_id,$3,false FROM runs WHERE id=$4`, id, jsonText(input), attempt, a.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.ConversationHistory(ctx, manager, id, attempt, nil); !errors.Is(err, ErrHistoryUnavailable) {
			t.Fatal("legacy/summary/foreign owner read history", err)
		}
		if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelled',slot_released=true WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
}

func TestM9SettingsResumeAndRevocation(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	p.Secrets, err = NewSecretVault(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{29}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	p.CredentialTLS = true
	if err = p.RegisterManager(ctx, "m7-test", 1); err != nil {
		t.Fatal(err)
	}
	h := m7DBHarness{t, p, ctx, files}
	workspaces, err := p.Workspaces(ctx)
	if err != nil {
		t.Fatal(err)
	}
	w := workspaces[0]
	tests, err := p.Tests(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	test := tests[0]
	var oldVersion string
	if err = p.DB.QueryRowContext(ctx, `SELECT row_to_json(v)::text FROM test_versions v WHERE id=$1`, test.PublishedVersionID).Scan(&oldVersion); err != nil {
		t.Fatal(err)
	}
	s, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	c, err := p.WorkspaceConversation(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	submission, err := p.CreateWorkspaceAuthor(ctx, w.ID, "update background", w.Revision, c.ContextRevision)
	if err != nil {
		t.Fatal(err)
	}
	a := h.claim(submission.Run.ID)
	config := m8Config()
	config.BackgroundSummary = "M9 new confirmed background"
	h.upload(a, "author.json", jsonText(workspaceAuthorOutput{Message: "proposal", Proposal: &config}))
	h.complete(a, "succeeded")
	h.release()
	w, err = p.Workspace(ctx, w.ID)
	if err != nil || w.CurrentProposal == nil {
		t.Fatal("proposal", err)
	}
	w, proposal, err := p.ActWorkspaceProposal(ctx, w.ID, w.CurrentProposal.ID, "confirm", w.Revision)
	if err != nil {
		t.Fatal(err)
	}
	resumed, created, err := p.StartEditingSession(ctx, test.ID)
	if err != nil || created || resumed.ID != s.ID || resumed.Draft.Revision != s.Draft.Revision+1 || resumed.Draft.Script != s.Draft.Script || resumed.Draft.ScriptOrigin != s.Draft.ScriptOrigin || resumed.Draft.WorkspaceContext.Config.BackgroundSummary != config.BackgroundSummary || resumed.Draft.ValidationRunID != nil || resumed.Summary != nil {
		t.Fatal("same-session resume did not retain new snapshot", err)
	}
	role := *proposal.Content.LoginRoles[0].RoleID
	ref, err := p.SaveWorkspaceCredentials(ctx, w.ID, role, 0, credentialValues{"synthetic-m9-user", "synthetic-m9-password"})
	if err != nil {
		t.Fatal(err)
	}
	resumed, _, err = p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	submission, err = p.CreateAuthor(ctx, test.ID, s.ID, "continue using updated background", resumed.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a = h.claim(submission.Run.ID)
	if a.WorkspaceContext.Config.BackgroundSummary != config.BackgroundSummary || a.Author.EditingSessionID != s.ID {
		t.Fatal("new author lost confirmed background")
	}
	request := CredentialRequest{role, *ref.SecretRef, *ref.SecretVersion}
	if _, err := p.ResolveWorkspaceCredentials(ctx, "m7-test", a.ID, a.AttemptID, request); err != nil {
		t.Fatal("current role unavailable", err)
	}
	if _, err := p.RevokeWorkspaceCredentials(ctx, w.ID, role, *ref.SecretVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := p.ResolveWorkspaceCredentials(ctx, "m7-test", a.ID, a.AttemptID, request); !errors.Is(err, ErrCredentialUnavailable) {
		t.Fatal("revoked role resolved", err)
	}
	if _, err := p.ConversationHistory(ctx, "m7-test", a.ID, a.AttemptID, nil); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("revoked/stale attempt read history", err)
	}
	run, err := p.Run(ctx, a.ID)
	if err != nil || run.Status != "cancelling" {
		t.Fatal("resolved-role revocation did not cancel attempt", err)
	}
	var version string
	if err = p.DB.QueryRowContext(ctx, `SELECT row_to_json(v)::text FROM test_versions v WHERE id=$1`, test.PublishedVersionID).Scan(&version); err != nil || version != oldVersion {
		t.Fatal("settings/role changes overwrote historical version", err)
	}
}
