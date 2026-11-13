//go:build integration

package server

import (
	"encoding/json"
	"testing"
)

func TestM10PostgresNormalAuthorSnapshots(t *testing.T) {
	m10SkillRoot(t)
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	item, err := p.CreateTest(ctx, w.ID, "test", "")
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	submission, err := p.CreateAuthor(ctx, item.ID, s.ID, "describe", s.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	var timeout int
	if err = p.DB.QueryRowContext(ctx, `SELECT author_payload,timeout_ms FROM runs WHERE id=$1`, submission.Run.ID).Scan(&raw, &timeout); err != nil {
		t.Fatal(err)
	}
	var input AuthorInput
	if err = json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Skills) != 2 || input.Budget == nil || timeout != input.Budget.MaxDurationMS || input.ToolRegistrySHA256 == "" || hasBrowserTools(&input) {
		t.Fatal("normal enqueue snapshot or scope incorrect")
	}
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	if err = validateToolSnapshot(input, registry, "read_conversation_history"); err != nil {
		t.Fatal(err)
	}
	workspace, err := p.CreateWorkspaceAuthor(ctx, w.ID, "plan", w.Revision, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT author_payload FROM runs WHERE id=$1`, workspace.Run.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	input = AuthorInput{}
	if err = json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Skills) != 1 || input.Skills[0].ID != "workspace-author" || hasBrowserTools(&input) {
		t.Fatal("workspace snapshot incorrect")
	}
}
