//go:build integration

package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/whippet/whippet/services/server/migrations"
)

type m7DBHarness struct {
	t     *testing.T
	p     *Postgres
	ctx   context.Context
	files *LocalArtifacts
}

func (h m7DBHarness) claim(id string) *Assignment {
	h.t.Helper()
	a, err := h.p.Claim(h.ctx, "m7-test", 1)
	if err != nil || a == nil || a.ID != id {
		h.t.Fatalf("claim %s: %+v %v", id, a, err)
	}
	return a
}
func (h m7DBHarness) upload(a *Assignment, name, body string) {
	h.t.Helper()
	item, err := h.files.Save(a.ID, a.AttemptID, name, strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	if err = h.p.SaveArtifact(h.ctx, item); err != nil {
		h.t.Fatal(err)
	}
}
func (h m7DBHarness) complete(a *Assignment, status string) {
	h.t.Helper()
	if err := h.p.Complete(h.ctx, "m7-test", a.ID, a.AttemptID, Result{Status: status}); err != nil {
		h.t.Fatal(err)
	}
}
func (h m7DBHarness) release() {
	h.t.Helper()
	if err := h.p.ReleaseSlots(h.ctx, "m7-test", nil); err != nil {
		h.t.Fatal(err)
	}
}

func TestM7EditingLifecycle(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	h := m7DBHarness{t, p, ctx, files}
	const testID = "10000000-0000-4000-8000-000000000001"
	const otherID = "10000000-0000-4000-8000-000000000002"
	item, err := p.Test(ctx, testID)
	if err != nil || item.ActiveEditingSession != nil {
		t.Fatalf("test pure read: %+v %v", item, err)
	}
	if s, err := p.EditingSession(ctx, testID, ""); err != nil || s != nil {
		t.Fatalf("session pure read: %+v %v", s, err)
	}
	if _, err := p.Draft(ctx, testID); !errors.Is(err, ErrNotFound) {
		t.Fatal("GET draft created a draft")
	}
	if _, err := p.Conversation(ctx, testID, ""); !errors.Is(err, ErrNotFound) {
		t.Fatal("GET conversation created data")
	}
	var count int
	if err := p.DB.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM drafts)+(SELECT count(*) FROM editing_sessions)+(SELECT count(*) FROM conversations)`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("reads added data: %d %v", count, err)
	}
	versions, err := p.Versions(ctx, testID)
	if err != nil || versions[0].Description != nil || versions[0].BackgroundSummary != nil {
		t.Fatal("legacy version metadata fabricated", err)
	}
	type started struct {
		s       EditingSession
		created bool
		err     error
	}
	ch := make(chan started, 2)
	for i := 0; i < 2; i++ {
		go func() { s, created, err := p.StartEditingSession(ctx, testID); ch <- started{s, created, err} }()
	}
	first, second := <-ch, <-ch
	if first.err != nil || second.err != nil || first.s.ID != second.s.ID || first.created == second.created {
		t.Fatalf("concurrent start/resume: %+v %+v", first, second)
	}
	session := first.s
	draft := *session.Draft
	if _, err := p.EditingSession(ctx, otherID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-Test session visible")
	}
	if _, err := p.Conversation(ctx, otherID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-Test conversation visible")
	}
	unnamed, err := p.CreateTest(ctx, session.WorkspaceID, "", "")
	if err != nil || unnamed.Name != "未命名測試" {
		t.Fatalf("new Test form gate: %+v %v", unnamed, err)
	}
	if err := p.RegisterManager(ctx, "m7-test", 1); err != nil {
		t.Fatal(err)
	}
	validation, err := p.ValidateDraft(ctx, testID, session.ID, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	v := h.claim(validation.ID)
	h.upload(v, "report.html", "<!doctype html><h1>passed</h1>")
	h.upload(v, "results.json", `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":12},"errors":[]}`)
	h.complete(v, "succeeded")
	summary, err := p.CreateSummary(ctx, testID, session.ID, draft.Revision, validation.ID)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := p.CreateSummary(ctx, testID, session.ID, draft.Revision, validation.ID)
	if err != nil || duplicate.ID != summary.ID {
		t.Fatalf("summary not idempotent: %+v %v", duplicate, err)
	}
	if _, err := p.Publish(ctx, testID, session.ID, draft.Revision, summary.ID, true); !errors.Is(err, ErrConflict) {
		t.Fatal("queued summary published")
	}
	h.release()
	a := h.claim(summary.ID)
	if a.Author.SkillID != "acceptance-summary" || a.Author.SkillVersion != "1" || len(a.Author.AllowedTools) != 0 || len(a.Author.Messages) != 0 || a.Author.ContextRevision != 0 || a.Author.ValidationEvidence.AttemptID != v.AttemptID || a.Author.ValidationEvidence.ScriptHash != scriptHash(draft.Script) || a.Author.ValidationEvidence.Stats.Expected != 1 {
		t.Fatalf("wrong summary input: %+v", a.Author)
	}
	h.upload(a, "author.json", `{"message":"bad","description":"","backgroundSummary":"b"}`)
	h.complete(a, "succeeded")
	h.release()
	failed, err := p.Run(ctx, summary.ID)
	if err != nil || failed.Status != "failed" {
		t.Fatalf("invalid summary accepted: %+v %v", failed, err)
	}
	summary, err = p.CreateSummary(ctx, testID, session.ID, draft.Revision, validation.ID)
	if err != nil {
		t.Fatal(err)
	}
	a = h.claim(summary.ID)
	const output = `{"message":"請確認","description":"Purpose; prerequisites; steps; assertions; limitations","backgroundSummary":"Non-secret context","name":"M7 published name"}`
	h.upload(a, "author.json", output)
	h.complete(a, "succeeded")
	h.release()
	ready, err := p.EditingSession(ctx, testID, session.ID)
	if err != nil || ready.Summary == nil || !ready.Summary.ValidForCurrentDraft || ready.ContextRevision != 0 {
		t.Fatalf("ready summary: %+v %v", ready, err)
	}
	convo, err := p.Conversation(ctx, testID, session.ID)
	if err != nil || len(convo.Messages) != 0 {
		t.Fatal("summary added fake chat", err)
	}
	before, err := p.Test(ctx, testID)
	if err != nil || before.Name == "M7 published name" {
		t.Fatal("summary renamed Test before confirmation")
	}
	edit, err := p.CreateAuthor(ctx, testID, session.ID, "補充新的目的", draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Publish(ctx, testID, session.ID, draft.Revision, summary.ID, true); !errors.Is(err, ErrConflict) {
		t.Fatal("old context summary published")
	}
	a = h.claim(edit.Run.ID)
	if a.Author.SkillID != "test-author" || a.Author.ContextRevision != 1 || len(a.Author.AllowedTools) != 9 || !containsHistoryTool(a.Author.AllowedTools) || a.Author.History == nil {
		t.Fatalf("wrong edit input: %+v", a.Author)
	}
	h.upload(a, "author.json", `{"message":"已理解新目的","requestValidation":false,"conversationSummary":"新目的與原檢查保持不變"}`)
	h.complete(a, "succeeded")
	h.release()
	current, err := p.EditingSession(ctx, testID, session.ID)
	if err != nil || current.ContextRevision != 2 || current.ConversationSummary == nil || *current.ConversationSummary != "新目的與原檢查保持不變" || current.Draft.ValidationRunID == nil || *current.Draft.ValidationRunID != validation.ID {
		t.Fatalf("edit recap/context invalidation: %+v %v", current, err)
	}
	summary, err = p.CreateSummary(ctx, testID, session.ID, draft.Revision, validation.ID)
	if err != nil {
		t.Fatal(err)
	}
	a = h.claim(summary.ID)
	h.upload(a, "author.json", output)
	h.complete(a, "succeeded")
	h.release()
	if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE editing_session_id=$1 AND kind='validation'`, session.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("summary retry reran validation: %d %v", count, err)
	}
	published, err := p.Publish(ctx, testID, session.ID, draft.Revision, summary.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if published.Description == nil || published.BackgroundSummary == nil || published.SummaryRunID == nil || *published.SummaryRunID != summary.ID {
		t.Fatal("published summary missing")
	}
	repeated, err := p.Publish(ctx, testID, session.ID, draft.Revision, summary.ID, true)
	if err != nil || repeated.ID != published.ID {
		t.Fatal("publish not idempotent", err)
	}
	h.complete(a, "succeeded") // Replay after publication cannot reconstruct a draft.
	if _, err := p.Draft(ctx, testID); !errors.Is(err, ErrNotFound) {
		t.Fatal("publication left/recreated draft")
	}
	formal, err := p.CreateRun(ctx, testID)
	if err != nil || formal.VersionID == nil || *formal.VersionID != published.ID || formal.EditingSessionID != nil {
		t.Fatalf("formal snapshot: %+v %v", formal, err)
	}
	next, created, err := p.StartEditingSession(ctx, testID)
	if err != nil || !created || next.ID == session.ID || next.Draft.Revision <= draft.Revision || next.SourceVersion == nil || next.SourceVersion.Description == nil || *next.SourceVersion.Description != *published.Description {
		t.Fatalf("new session source: %+v %v", next, err)
	}
	edit, err = p.CreateAuthor(ctx, testID, next.ID, "候選稿稍後放棄", next.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	// Discarding an editing period must not cancel a formal Run.
	if _, err = p.Cancel(ctx, edit.Run.ID); err != nil {
		t.Fatal(err)
	}
	done, err := p.DiscardEditingSession(ctx, testID, next.ID, next.Draft.Revision)
	if err != nil || done.Status != "discarded" {
		t.Fatalf("queued discard: %+v %v", done, err)
	}
	formalState, err := p.Run(ctx, formal.ID)
	if err != nil || formalState.Status != "queued" {
		t.Fatal("discard cancelled formal Run")
	}
	if _, err = p.Cancel(ctx, formal.ID); err != nil {
		t.Fatal(err)
	} // Explicit test cleanup of unrelated queued work.
	next, _, err = p.StartEditingSession(ctx, testID)
	if err != nil {
		t.Fatal(err)
	}
	edit, err = p.CreateAuthor(ctx, testID, next.ID, "這個正在執行的修改要放棄", next.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a = h.claim(edit.Run.ID)
	h.upload(a, "author.json", `{"message":"late","script":"must not apply","requestValidation":true,"conversationSummary":"must not replace"}`)
	closing, err := p.DiscardEditingSession(ctx, testID, next.ID, next.Draft.Revision)
	if err != nil || closing.Status != "discarding" || closing.Draft == nil || !closing.ReclaimPending {
		t.Fatalf("discard did not wait for cleanup: %+v %v", closing, err)
	}
	h.complete(a, "succeeded")
	if err = p.FinalizeDiscardingSessions(ctx); err != nil {
		t.Fatal(err)
	}
	closingPtr, err := p.EditingSession(ctx, testID, next.ID)
	if err != nil || closingPtr.Status != "discarding" {
		t.Fatal("terminal result released cleanup barrier", err)
	}
	if err = p.ReleaseSlots(ctx, "m7-test", []ActiveAttempt{{RunID: a.ID, AttemptID: a.AttemptID}}); err != nil {
		t.Fatal(err)
	}
	if err = p.FinalizeDiscardingSessions(ctx); err != nil {
		t.Fatal(err)
	}
	h.release()
	restarted := &Postgres{DB: p.DB, Artifacts: files}
	if err = restarted.FinalizeDiscardingSessions(ctx); err != nil {
		t.Fatal(err)
	}
	closed, err := p.EditingSession(ctx, testID, next.ID)
	if err != nil || closed.Status != "discarded" || closed.Draft != nil {
		t.Fatalf("discard not durable: %+v %v", closed, err)
	}
	newest, _, err := p.StartEditingSession(ctx, testID)
	if err != nil || newest.Draft.Revision <= next.Draft.Revision {
		t.Fatal("revision reused", err)
	}
	h.complete(a, "succeeded")
	unchanged, err := p.Draft(ctx, testID)
	if err != nil || unchanged.Revision != newest.Draft.Revision || unchanged.Script != newest.Draft.Script || unchanged.ValidationRunID != nil {
		t.Fatal("late result revived or changed draft", err)
	}
	if _, err = p.Artifact(ctx, a.ID, "author.json"); err != nil {
		t.Fatal("discard removed historical evidence", err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE test_versions SET description='overwritten' WHERE id=$1`, published.ID); err == nil {
		t.Fatal("version description mutable")
	}
}

func TestM7LegacyMigration(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"001_initial.sql", "002_seed.sql", "003_drafts_and_publication.sql", "004_conversations_and_author.sql", "005_report_screenshots.sql", "006_workspace_settings.sql", "007_failure_evidence.sql"} {
		body, err := migrations.Files.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.ExecContext(ctx, string(body)); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO schema_migrations(name) VALUES($1)`, name); err != nil {
			t.Fatal(err)
		}
	}
	const archivedID = "10000000-0000-4000-8000-000000000001"
	const activeID = "10000000-0000-4000-8000-000000000002"
	unpublishedID := NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO tests(id,workspace_id,name) VALUES($1,'00000000-0000-4000-8000-000000000001','unpublished')`, unpublishedID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{archivedID, activeID, unpublishedID} {
		var script string
		if err = tx.QueryRowContext(ctx, `SELECT COALESCE(v.script,'') FROM tests t LEFT JOIN test_versions v ON v.id=t.published_version_id WHERE t.id=$1`, id).Scan(&script); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings)
         VALUES($1,5,$2,$3,60000,'{"revision":1,"sites":[],"defaultTestUrl":"","timeoutMs":60000}')`, id, script, scriptHash(script)); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO drafts(test_id,current_revision) VALUES($1,5)`, id); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO conversations(id,test_id) VALUES($1,$2)`, NewID(), id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE tests SET description='not historical version metadata' WHERE id=$1`, archivedID); err != nil {
		t.Fatal(err)
	}
	var conversationID, script string
	if err = tx.QueryRowContext(ctx, `SELECT c.id,dr.script FROM conversations c JOIN draft_revisions dr ON dr.test_id=c.test_id WHERE c.test_id=$1`, activeID).Scan(&conversationID, &script); err != nil {
		t.Fatal(err)
	}
	input := AuthorInput{ConversationID: conversationID, BaseRevision: 5, Messages: []ChatMessage{{Role: "user", Content: "legacy"}}}
	payload, _ := json.Marshal(input)
	runID := NewID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO runs(id,test_id,kind,draft_revision,script_snapshot,script_hash,timeout_ms,workspace_settings,author_payload)
       VALUES($1,$2,'author',5,$3,$4,180000,'{"revision":1,"sites":[],"defaultTestUrl":"","timeoutMs":60000}',$5)`, runID, activeID, script, scriptHash(script), string(payload)); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err = p.Migrate(ctx); err != nil {
		t.Fatal("idempotent migration", err)
	}
	if session, err := p.EditingSession(ctx, archivedID, ""); err != nil || session != nil {
		t.Fatalf("unchanged published legacy draft stayed active: %+v %v", session, err)
	}
	if _, err = p.Draft(ctx, archivedID); !errors.Is(err, ErrNotFound) {
		t.Fatal("unchanged legacy draft pointer retained")
	}
	for _, id := range []string{activeID, unpublishedID} {
		s, err := p.EditingSession(ctx, id, "")
		if err != nil || s == nil || s.Status != "active" || s.Draft.Revision != 5 || s.SourceVersionID != nil || s.ConversationSummary != nil {
			t.Fatalf("real/active legacy edits not preserved: %+v %v", s, err)
		}
	}
	var persisted []byte
	var sid string
	if err = p.DB.QueryRowContext(ctx, `SELECT author_payload,editing_session_id FROM runs WHERE id=$1`, runID).Scan(&persisted, &sid); err != nil {
		t.Fatal(err)
	}
	var old, newInput any
	json.Unmarshal(payload, &old)
	json.Unmarshal(persisted, &newInput)
	oldJSON, _ := json.Marshal(old)
	newJSON, _ := json.Marshal(newInput)
	if string(oldJSON) != string(newJSON) {
		t.Fatal("migration rewrote legacy author input")
	}
	versions, err := p.Versions(ctx, archivedID)
	if err != nil || versions[0].Description != nil || versions[0].BackgroundSummary != nil {
		t.Fatal("legacy version fabricated description", err)
	}
	opened, _, err := p.StartEditingSession(ctx, archivedID)
	if err != nil || opened.Draft.Revision != 6 {
		t.Fatalf("archived revision reused: %+v %v", opened, err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET editing_session_id=NULL WHERE id=$1`, runID); err == nil {
		t.Fatal("new run/session snapshot binding is mutable")
	}
}
