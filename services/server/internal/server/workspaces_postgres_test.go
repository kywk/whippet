//go:build integration

package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/whippet/whippet/services/server/migrations"
)

// Only the explicitly supplied test database is used. Each case owns a new
// random schema; cleanup cannot affect public or another test's schema.
func workspaceTestDB(t *testing.T) (*Postgres, context.Context) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to an isolated PostgreSQL test database")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		t.Fatal("TEST_DATABASE_URL must be a PostgreSQL URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal("open isolated test database")
	}
	t.Cleanup(func() { admin.Close() })
	schema := "whippet_m5_" + strings.ReplaceAll(NewID(), "-", "")
	if _, err := admin.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal("create isolated test schema")
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if _, err := admin.ExecContext(cleanup, `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Error("remove isolated test schema")
		}
	})
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	db, err := sql.Open("postgres", u.String())
	if err != nil {
		t.Fatal("open isolated test schema")
	}
	t.Cleanup(func() { db.Close() })
	return &Postgres{DB: db}, ctx
}

func TestPostgresWorkspaceSettingsSnapshots(t *testing.T) {
	t.Run("fresh_001_to_006_and_settings_transaction", func(t *testing.T) {
		p, ctx := workspaceTestDB(t)
		if err := p.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
		if err := p.Migrate(ctx); err != nil {
			t.Fatalf("idempotent migration: %v", err)
		}
		workspaces, err := p.Workspaces(ctx)
		if err != nil || len(workspaces) != 1 {
			t.Fatalf("workspaces: %+v %v", workspaces, err)
		}
		w := workspaces[0]
		tests, err := p.Tests(ctx, w.ID)
		if err != nil || len(tests) != 2 {
			t.Fatalf("seed tests: %+v %v", tests, err)
		}
		files, err := NewLocalArtifacts(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		p.Artifacts = files
		started, _, err := p.StartEditingSession(ctx, tests[0].ID)
		if err != nil {
			t.Fatal(err)
		}
		draft := *started.Draft
		if err != nil || !sameWorkspaceSettings(draft.WorkspaceSettings, &w.WorkspaceSettings) {
			t.Fatalf("initial draft: %+v %v", draft, err)
		}
		validation, err := p.ValidateDraft(ctx, draft.TestID, draft.EditingSessionID, draft.Revision)
		if err != nil {
			t.Fatal(err)
		}
		const manager = "m5-test-manager"
		if err := p.RegisterManager(ctx, manager, 1); err != nil {
			t.Fatal(err)
		}
		claim := func(id string) *Assignment {
			t.Helper()
			a, err := p.Claim(ctx, manager, 1)
			if err != nil || a == nil || a.ID != id {
				t.Fatalf("claim %s: %+v %v", id, a, err)
			}
			return a
		}
		upload := func(a *Assignment, name, body string) {
			t.Helper()
			artifact, err := files.Save(a.ID, a.AttemptID, name, strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			if err := p.SaveArtifact(ctx, artifact); err != nil {
				t.Fatal(err)
			}
		}
		finish := func(a *Assignment, status string) {
			t.Helper()
			if err := p.Complete(ctx, manager, a.ID, a.AttemptID, Result{Status: status}); err != nil {
				t.Fatal(err)
			}
			if err := p.ReleaseSlots(ctx, manager, nil); err != nil {
				t.Fatal(err)
			}
		}
		a := claim(validation.ID)
		upload(a, "report.html", "<!doctype html><h1>passed</h1>")
		upload(a, "results.json", `{"status":"passed"}`)
		finish(a, "succeeded")
		initialVersions, err := p.Versions(ctx, draft.TestID)
		published := initialVersions[0]
		if err != nil {
			t.Fatal(err)
		}
		queued, err := p.CreateRun(ctx, draft.TestID)
		if err != nil {
			t.Fatal(err)
		}
		author, err := p.CreateAuthor(ctx, draft.TestID, draft.EditingSessionID, "change the draft", draft.Revision)
		if err != nil {
			t.Fatal(err)
		}
		before, err := p.Draft(ctx, draft.TestID)
		if err != nil {
			t.Fatal(err)
		}
		noOp, err := p.PatchWorkspace(ctx, w.ID, WorkspacePatch{Revision: w.Revision, Sites: &w.Sites, TimeoutMS: &w.TimeoutMS})
		unchanged, draftErr := p.Draft(ctx, draft.TestID)
		if err != nil || draftErr != nil || noOp.Revision != w.Revision || unchanged.Revision != before.Revision ||
			unchanged.ValidationRunID == nil || *unchanged.ValidationRunID != validation.ID {
			t.Fatalf("no-op invalidated validation: %+v %+v %v %v", noOp, unchanged, err, draftErr)
		}
		newURL, timeout := "https://example.test/new", 23456
		sites := []WorkspaceSite{{Name: " New site ", URL: "https://example.test/"}}
		updated, err := p.PatchWorkspace(ctx, w.ID, WorkspacePatch{Revision: w.Revision, Sites: &sites, DefaultTestURL: &newURL, TimeoutMS: &timeout})
		if err != nil || updated.Revision != w.Revision+1 || updated.Sites[0].Name != "New site" {
			t.Fatalf("settings PATCH: %+v %v", updated, err)
		}
		if _, err := p.PatchWorkspace(ctx, w.ID, WorkspacePatch{Revision: w.Revision}); !errors.Is(err, ErrConflict) {
			t.Fatalf("stale Workspace PATCH: %v", err)
		}
		reloaded, err := p.Workspace(ctx, w.ID)
		if err != nil || !sameWorkspaceSettings(&updated.WorkspaceSettings, &reloaded.WorkspaceSettings) {
			t.Fatalf("settings persistence: %+v %v", reloaded, err)
		}
		after, err := p.Draft(ctx, draft.TestID)
		if err != nil || after.Revision != before.Revision+1 || after.Script != before.Script || after.ValidationRunID != nil ||
			after.ValidationStatus != "" || after.ReportURL != "" || !sameWorkspaceSettings(after.WorkspaceSettings, &updated.WorkspaceSettings) {
			t.Fatalf("settings did not invalidate draft atomically: %+v %v", after, err)
		}
		for _, revision := range []int{before.Revision, after.Revision} {
			if _, err := p.Publish(ctx, draft.TestID, draft.EditingSessionID, revision, NewID(), true); !errors.Is(err, ErrConflict) {
				t.Fatalf("old successful validation published revision %d: %v", revision, err)
			}
		}
		versions, err := p.Versions(ctx, draft.TestID)
		if err != nil || versions[0].ID != published.ID || !sameWorkspaceSettings(versions[0].WorkspaceSettings, &w.WorkspaceSettings) {
			t.Fatalf("published snapshot changed: %+v %v", versions, err)
		}
		for _, runID := range []string{queued.ID, author.Run.ID, validation.ID} {
			run, err := p.Run(ctx, runID)
			if err != nil || !sameWorkspaceSettings(run.WorkspaceSettings, &w.WorkspaceSettings) {
				t.Fatalf("existing run snapshot changed: %+v %v", run, err)
			}
		}
		// A new formal run still uses the old published settings, not Workspace.
		formal, err := p.CreateRun(ctx, draft.TestID)
		if err != nil || !sameWorkspaceSettings(formal.WorkspaceSettings, &w.WorkspaceSettings) {
			t.Fatalf("formal run read live Workspace: %+v %v", formal, err)
		}
		a = claim(queued.ID)
		if a.TimeoutMS != w.TimeoutMS || !sameWorkspaceSettings(a.WorkspaceSettings, &w.WorkspaceSettings) {
			t.Fatalf("claim changed queued snapshot: %+v", a)
		}
		finish(a, "cancelled")
		a = claim(author.Run.ID)
		if a.TimeoutMS != authorTimeoutMS || !sameWorkspaceSettings(a.WorkspaceSettings, &w.WorkspaceSettings) || a.Author.BaseRevision != before.Revision {
			t.Fatalf("author input snapshot changed: %+v", a)
		}
		upload(a, "author.json", `{"message":"candidate","script":"changed candidate","requestValidation":true}`)
		finish(a, "succeeded")
		if err := p.Complete(ctx, manager, a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
			t.Fatalf("duplicate author result: %v", err)
		}
		conflicted, err := p.Draft(ctx, draft.TestID)
		conversation, convoErr := p.Conversation(ctx, draft.TestID, draft.EditingSessionID)
		if err != nil || convoErr != nil || conflicted.Revision != after.Revision || conflicted.Script != after.Script || conflicted.ValidationRunID != nil || len(conversation.Messages) != 2 {
			t.Fatalf("old author applied/queued validation: %+v %+v %v %v", conflicted, conversation, err, convoErr)
		}
		message := conversation.Messages[1]
		if message.ProposedScript == nil || *message.ProposedScript != "changed candidate" || message.AppliedRevision != nil || message.ValidationRunID != nil {
			t.Fatalf("conflicted author proposal lost: %+v", message)
		}
		second, _, err := p.StartEditingSession(ctx, tests[1].ID)
		if err != nil {
			t.Fatal(err)
		}
		newDraft := *second.Draft
		if err != nil || !sameWorkspaceSettings(newDraft.WorkspaceSettings, &updated.WorkspaceSettings) || !strings.Contains(newDraft.Script, "test(") {
			t.Fatalf("new draft did not adopt current settings and published script: %+v %v", newDraft, err)
		}
		newValidation, err := p.ValidateDraft(ctx, draft.TestID, draft.EditingSessionID, after.Revision)
		if err != nil || !sameWorkspaceSettings(newValidation.WorkspaceSettings, &updated.WorkspaceSettings) {
			t.Fatalf("new validation snapshot: %+v %v", newValidation, err)
		}
		var validationCount int
		if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='validation'`, draft.TestID).Scan(&validationCount); err != nil || validationCount != 2 {
			t.Fatalf("author queued an unexpected validation: count=%d err=%v", validationCount, err)
		}
	})

	t.Run("upgrade_005_non_default_timeouts_and_immutability", func(t *testing.T) {
		p, ctx := workspaceTestDB(t)
		tx, err := p.DB.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, `CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"001_initial.sql", "002_seed.sql", "003_drafts_and_publication.sql", "004_conversations_and_author.sql", "005_report_screenshots.sql"} {
			body, err := migrations.Files.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(name) VALUES($1)`, name); err != nil {
				t.Fatal(err)
			}
		}
		const testID = "10000000-0000-4000-8000-000000000001"
		versionID, runID, authorID := NewID(), NewID(), NewID()
		const script = "legacy script must not change"
		if _, err := tx.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms) VALUES($1,$2,2,$3,12345)`, versionID, testID, script); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms) VALUES($1,1,$2,$3,23456)`, testID, script, scriptHash(script)); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO drafts(test_id,current_revision) VALUES($1,1)`, testID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO runs(id,test_id,version_id,script_snapshot,timeout_ms) VALUES($1,$2,$3,$4,34567)`, runID, testID, versionID, script); err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(AuthorInput{ConversationID: NewID(), BaseRevision: 1, Messages: []ChatMessage{{Role: "user", Content: "legacy author"}}})
		if _, err := tx.ExecContext(ctx, `INSERT INTO runs(id,test_id,kind,draft_revision,script_snapshot,script_hash,timeout_ms,author_payload)
		    VALUES($1,$2,'author',1,$3,$4,180000,$5)`, authorID, testID, script, scriptHash(script), string(payload)); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		if err := p.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct {
			table, idColumn, id      string
			timeout, settingsTimeout int
		}{
			{"test_versions", "id", versionID, 12345, 12345},
			{"draft_revisions", "test_id", testID, 23456, 23456},
			{"runs", "id", runID, 34567, 34567},
			{"runs", "id", authorID, 180000, 23456},
		} {
			var timeout int
			var raw []byte
			if err := p.DB.QueryRowContext(ctx, `SELECT timeout_ms,workspace_settings FROM `+tc.table+` WHERE `+tc.idColumn+`=$1`, tc.id).Scan(&timeout, &raw); err != nil {
				t.Fatal(err)
			}
			settings, err := decodeSettings(raw)
			if err != nil || timeout != tc.timeout || settings.TimeoutMS != tc.settingsTimeout || settings.Revision != 1 || len(settings.Sites) != 0 || settings.DefaultTestURL != "" {
				t.Fatalf("%s historical timeout changed: timeout=%d settings=%+v err=%v", tc.table, timeout, settings, err)
			}
			if _, err := p.DB.ExecContext(ctx, `UPDATE `+tc.table+` SET workspace_settings=jsonb_set(workspace_settings,'{timeoutMs}','999') WHERE `+tc.idColumn+`=$1`, tc.id); err == nil {
				t.Fatalf("%s settings snapshot is mutable after upgrade", tc.table)
			}
		}
		for _, tc := range []struct{ table, idColumn, scriptColumn, id string }{
			{"test_versions", "id", "script", versionID}, {"draft_revisions", "test_id", "script", testID}, {"runs", "id", "script_snapshot", runID},
		} {
			var saved string
			if err := p.DB.QueryRowContext(ctx, `SELECT `+tc.scriptColumn+` FROM `+tc.table+` WHERE `+tc.idColumn+`=$1`, tc.id).Scan(&saved); err != nil || saved != script {
				t.Fatalf("%s historical script changed: %v", tc.table, err)
			}
			if _, err := p.DB.ExecContext(ctx, `UPDATE `+tc.table+` SET `+tc.scriptColumn+`='overwritten' WHERE `+tc.idColumn+`=$1`, tc.id); err == nil {
				t.Fatalf("%s script protection lost after upgrade", tc.table)
			}
		}
	})
}
