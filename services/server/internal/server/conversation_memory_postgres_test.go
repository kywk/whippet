//go:build integration && m12memory

package server

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestConversationMemoryPostgresWorkerPersistAndReadBack(t *testing.T) {
	m10SkillRoot(t)
	cleanRuntimeEnv(t)
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "memory fixture")
	if err != nil {
		t.Fatal(err)
	}
	item, err := p.CreateTest(ctx, w.ID, "memory fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []ChatMessage{{Role: "user", Content: "目標：驗證付款失敗。限制：不得刪除斷言。其他退款限制也保留。"}, {Role: "assistant", Content: "進度：目前 verify。證據：run/fixed 仍須查核。" + strings.Repeat("earlier explanation ", 100)}} {
		if _, err = p.DB.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,$3,$4)`, NewID(), s.ConversationID, m.Role, m.Content); err != nil {
			t.Fatal(err)
		}
	}
	sub, err := p.CreateAuthor(ctx, item.ID, s.ID, "依原限制整理對話，不自動發佈", s.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "memory-manager", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "memory-manager", 1)
	if err != nil || a == nil || a.ID != sub.Run.ID {
		t.Fatal("claim", err)
	}
	var before string
	if err = p.DB.QueryRowContext(ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, a.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	page, err := snapshotHistory(p, ctx, "memory-manager", a.ID, a.AttemptID, nil)
	if err != nil {
		t.Fatal("frozen source", err)
	}
	worker := map[string]any{"kind": "author", "runId": a.ID, "attemptId": a.AttemptID, "script": a.Script, "timeoutMs": a.TimeoutMS, "workspaceId": a.WorkspaceID, "testId": a.TestID, "workspaceContext": a.WorkspaceContext, "scriptOrigin": a.ScriptOrigin, "author": a.Author}
	command := exec.CommandContext(ctx, "node", repositoryFile("scripts", "test", "m12-conversation-memory-worker.mjs"))
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "WHIPPET_SKILLS_PATH=" + repositoryFile("runtimes", "worker", "skills")}
	command.Stdin = strings.NewReader(jsonText(map[string]any{"input": worker, "page": page}))
	var diagnostics bytes.Buffer
	command.Stderr = &diagnostics
	raw, err := command.Output()
	if err != nil {
		t.Fatalf("synthetic Worker: %v %s", err, diagnostics.String())
	}
	out, err := decodeAuthorOutput(raw)
	if err != nil || out.ConversationSummary == nil {
		t.Fatal("guarded summary", err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	artifact, err := files.Save(a.ID, a.AttemptID, "author.json", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if err = p.SaveArtifact(ctx, artifact); err != nil {
		t.Fatal(err)
	}
	if err = p.Complete(ctx, "memory-manager", a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if err = p.ReleaseSlots(ctx, "memory-manager", nil); err != nil {
		t.Fatal(err)
	}
	saved, err := p.EditingSession(ctx, item.ID, s.ID)
	if err != nil || saved.ConversationSummary == nil || *saved.ConversationSummary != *out.ConversationSummary {
		t.Fatal("summary not persisted", err)
	}
	if _, err = p.CreateAuthor(ctx, item.ID, s.ID, "繼續原任務", s.Draft.Revision); err != nil {
		t.Fatal(err)
	}
	next, err := p.Claim(ctx, "memory-manager", 1)
	if err != nil || next == nil || next.Author.ConversationSummary == nil || *next.Author.ConversationSummary != *out.ConversationSummary {
		t.Fatal("next immutable input", err)
	}
	cursor := page.MaxSequence + ":0"
	reread, err := snapshotHistory(p, ctx, "memory-manager", next.ID, next.AttemptID, &cursor)
	if err != nil {
		t.Fatal("read prior source in next Run", err)
	}
	if jsonText(page.Items) != jsonText(reread.Items) || stringValue(page.NextCursor) != stringValue(reread.NextCursor) {
		t.Fatal("old source drifted after new messages")
	}
	var after string
	if err = p.DB.QueryRowContext(ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, a.ID).Scan(&after); err != nil || after != before {
		t.Fatal("historical Run rewritten", err)
	}
	var memory map[string]any
	if json.Unmarshal([]byte(*out.ConversationSummary), &memory) != nil || memory["validationEvidence"] != false {
		t.Fatal("memory became validation authority")
	}
}
