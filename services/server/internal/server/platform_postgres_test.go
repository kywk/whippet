//go:build integration

package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

// Direct SQL versions are fixtures for immutable reference semantics, not a
// substitute for the later real bundle validation/publication acceptance flow.
func TestM10PostgresModuleCatalogAndDependencies(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "M10 isolated")
	if err != nil {
		t.Fatal(err)
	}
	other, err := p.CreateWorkspace(ctx, "other")
	if err != nil {
		t.Fatal(err)
	}
	slug := "login"
	module, err := p.CreatePlatformTest(ctx, w.ID, "Login", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	if module.Kind != "module" || stringValue(module.Slug) != slug {
		t.Fatal("module identity missing")
	}
	if _, err := p.CreatePlatformTest(ctx, w.ID, "Duplicate", "", "module", &slug); err == nil {
		t.Fatal("duplicate workspace slug accepted")
	}
	foreign, err := p.CreatePlatformTest(ctx, other.ID, "Foreign", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, module.ID)
	if err != nil {
		t.Fatal(err)
	}
	metadata := &Module{Slug: slug, ModuleKind: "setup", ExportName: "login", Signature: "login({page})", Harness: "test('harness', async ({page}) => {});"}
	draft, err := p.SavePlatformDraft(ctx, module.ID, session.ID, session.Draft.Revision, "export async function login({page}) {}", metadata, nil)
	if err != nil {
		t.Fatal(err)
	}
	if draft.Module == nil || draft.Module.ExportName != "login" {
		t.Fatal("metadata not persisted")
	}
	// Ordinary manual script edits preserve metadata but invalidate validation.
	draft, err = p.SaveDraft(ctx, module.ID, session.ID, draft.Revision, draft.Script+"\n")
	if err != nil || draft.Module == nil {
		t.Fatal("script edit lost metadata", err)
	}
	if _, err = p.ValidateDraft(ctx, module.ID, session.ID, draft.Revision); err != nil {
		t.Fatal("Module harness validation enqueue", err)
	}
	if catalog, err := p.Catalog(ctx, w.ID); err != nil || len(catalog) != 0 {
		t.Fatal("unpublished draft leaked to Catalog", err)
	}
	insertVersion := func(test string, version int, metadata *Module) string {
		t.Helper()
		id := NewID()
		_, err := p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,module,workspace_settings) VALUES($1,$2,$3,'fixture',30000,$4,$5)`, id, test, version, jsonText(metadata), settingsJSON(&w.WorkspaceSettings))
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	first := insertVersion(module.ID, 1, metadata)
	second := insertVersion(module.ID, 2, metadata)
	foreignVersion := insertVersion(foreign.ID, 1, metadata)
	if _, err := p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, module.ID, second); err != nil {
		t.Fatal(err)
	}
	stages := []Stage{{ID: "login", Title: "Login", Kind: "module", ModuleTestID: module.ID, ModuleVersionID: first}}
	deps, err := resolveModuleDependencies(ctx, p.DB, w.ID, stages)
	if err != nil || len(deps) != 1 || deps[0].ModuleVersionID != first {
		t.Fatal("dependency followed latest instead of pinned version", err)
	}
	stages[0].ModuleTestID = foreign.ID
	stages[0].ModuleVersionID = foreignVersion
	if _, err := resolveModuleDependencies(ctx, p.DB, w.ID, stages); !errors.Is(err, ErrInvalid) {
		t.Fatal("cross Workspace dependency accepted", err)
	}
	usecase, err := p.CreatePlatformTest(ctx, w.ID, "flow", "", "usecase", nil)
	if err != nil {
		t.Fatal(err)
	}
	source := NewID()
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings) VALUES($1,$2,1,'fixture',30000,$3)`, source, usecase.ID, settingsJSON(&w.WorkspaceSettings)); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO version_dependencies(version_id,module_version_id) VALUES($1,$2)`, source, first); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO version_dependencies(version_id,module_version_id) VALUES($1,$2)`, source, second); err == nil {
		t.Fatal("dependency appended after publication transaction")
	}

	for _, pair := range []struct{ test, target string }{{usecase.ID, foreignVersion}, {module.ID, first}} {
		tx, err := p.DB.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		candidate := NewID()
		_, err = tx.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings) VALUES($1,$2,3,'fixture',30000,$3)`, candidate, pair.test, settingsJSON(&w.WorkspaceSettings))
		if err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO version_dependencies(version_id,module_version_id) VALUES($1,$2)`, candidate, pair.target)
		tx.Rollback()
		if err == nil {
			t.Fatal("DB accepted cross Workspace or Module dependency")
		}
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE version_dependencies SET module_version_id=$2 WHERE version_id=$1`, source, second); err == nil {
		t.Fatal("immutable dependency mutated")
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE tests SET slug='renamed' WHERE id=$1`, module.ID); err == nil {
		t.Fatal("slug mutated")
	}
	catalog, err := p.Catalog(ctx, w.ID)
	if err != nil || len(catalog) != 1 || catalog[0].VersionID != second || len(catalog[0].ReferencedBy) != 1 || catalog[0].ReferencedBy[0].VersionID != source {
		t.Fatalf("catalog isolation/reference mismatch: %+v %v", catalog, err)
	}
	// The legacy default survives additive migration.
	legacy, err := p.CreateTest(ctx, w.ID, "plain", "")
	if err != nil || legacy.Kind != "test" {
		t.Fatal("legacy default", err)
	}
	legacySession, _, err := p.StartEditingSession(ctx, legacy.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := p.SaveDraft(ctx, legacy.ID, legacySession.ID, legacySession.Draft.Revision, "test('legacy',()=>{})")
	if err != nil || saved.Module != nil || len(saved.Stages) != 0 {
		t.Fatal("legacy snapshot defaults", err)
	}
	if versions, err := p.Versions(ctx, module.ID); err != nil || len(versions) != 2 || versions[0].Module == nil {
		t.Fatal("version metadata scan", err)
	}

}

func m10HistoryFixture(t *testing.T, p *Postgres, ctx context.Context, modelRequests ...int) (string, string) {
	t.Helper()
	w, err := p.CreateWorkspace(ctx, "M10 IPC")
	if err != nil {
		t.Fatal(err)
	}
	test, err := p.CreateTest(ctx, w.ID, "IPC", "")
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	d, s, err := requireEditingDraft(ctx, tx, test.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'user','M10 fixture')`, NewID(), s.ConversationID); err != nil {
		t.Fatal(err)
	}
	input := editingAuthorInput(s, d, "test-author", []ChatMessage{{Role: "user", Content: "Read the saved synthetic history"}})
	input.AllowedTools = []string{"read_conversation_history"}
	input.History, err = conversationHistorySnapshot(ctx, tx, s.ConversationID)
	if err != nil {
		t.Fatal(err)
	}
	if err = snapshotAuthor(&input); err != nil {
		t.Fatal(err)
	}
	if len(modelRequests) > 0 {
		input.Budget.MaxModelRequests = modelRequests[0]
	}
	run, err := enqueueAuthorSnapshot(ctx, tx, d, input)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return run.ID, test.ID
}
func TestM10PostgresHarnessAttemptAndReplay(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	runID, _ := m10HistoryFixture(t, p, ctx)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, log)
	defer engine.Close()
	session, err := engine.Attach(ctx, "m10-manager", 1, &recordPeer{})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Handle(ctx, session, NewEnvelope("heartbeat", "m10-manager", "", "", struct {
		Active []ActiveAttempt `json:"active"`
	}{[]ActiveAttempt{}})); err != nil {
		t.Fatal(err)
	}
	if err := engine.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	assignments, err := p.Assignments(ctx, "m10-manager")
	if err != nil || len(assignments) != 1 || assignments[0].ID != runID {
		t.Fatal("assignment", err)
	}
	attempt := assignments[0].AttemptID
	handler := NewAPI(p, nil, engine, "synthetic-m10-token", log).Handler(nil)
	call := func(attempt, callID, args string) int {
		t.Helper()
		body := jsonText(HarnessToolRequest{CallID: callID, Name: "read_conversation_history", Arguments: json.RawMessage(args)})
		r := httptest.NewRequest("POST", "https://server/api/manager/runs/"+runID+"/attempts/"+attempt+"/tools", strings.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.Header.Set("Authorization", "Bearer synthetic-m10-token")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response.Code
	}
	id := NewID()
	if code := call(NewID(), id, `{"cursor":null}`); code != 409 {
		t.Fatalf("wrong attempt status %d", code)
	}
	if code := call(attempt, id, `{"cursor":null}`); code != 200 {
		t.Fatalf("valid attempt status %d", code)
	}
	if code := call(attempt, id, `{"cursor":null}`); code != 200 {
		t.Fatalf("idempotent retry %d", code)
	}
	if code := call(attempt, id, `{"cursor":"0:0"}`); code != 409 {
		t.Fatalf("changed call payload %d", code)
	}
	for n := 0; n < 3; n++ {
		if code := call(attempt, NewID(), `{"cursor":null}`); code != 200 {
			t.Fatalf("history page %d: %d", n, code)
		}
	}
	if code := call(attempt, NewID(), `{"cursor":null}`); code != 409 {
		t.Fatalf("four page cap %d", code)
	}
	if _, err := p.Cancel(ctx, runID); err != nil {
		t.Fatal(err)
	}
	if code := call(attempt, id, `{"cursor":null}`); code != 409 {
		t.Fatalf("cancel replay bypassed authorization: %d", code)
	}
}
