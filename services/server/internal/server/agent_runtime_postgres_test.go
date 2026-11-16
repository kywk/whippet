//go:build integration

package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestM12RuntimePostgresCASAndFrozenDispatch(t *testing.T) {
	cleanRuntimeEnv(t)
	m10SkillRoot(t)
	f := setupM10Partial(t)
	read := func(id string) AuthorInput {
		t.Helper()
		var raw []byte
		var input AuthorInput
		if err := f.p.DB.QueryRowContext(f.ctx, `SELECT author_payload FROM runs WHERE id=$1`, id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if json.Unmarshal(raw, &input) != nil || !validAuthorRuntime(input.Runtime) {
			t.Fatal("invalid persisted runtime")
		}
		return input
	}
	source := read(f.assignment.ID)
	if source.Runtime.Engine != "builtin" || f.assignment.Author.Runtime.SHA256 != source.Runtime.SHA256 {
		t.Fatal("default dispatch")
	}
	var workspace string
	if err := f.p.DB.QueryRowContext(f.ctx, `SELECT workspace_id FROM tests WHERE id=$1`, f.testID).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	selection := RuntimeSelection{ProfileID: "vercel", SkillProfiles: map[string]string{"workspace-author": "builtin"}}
	item, err := f.p.SetAgentRuntime(f.ctx, workspace, 1, selection)
	if err != nil || item.(map[string]any)["revision"] != 2 {
		t.Fatal("CAS update", err)
	}
	if _, err = f.p.SetAgentRuntime(f.ctx, workspace, 1, selection); !errors.Is(err, ErrConflict) {
		t.Fatal("stale CAS accepted", err)
	}
	if _, err = f.p.SetAgentRuntime(f.ctx, workspace, 2, RuntimeSelection{"unknown", map[string]string{}}); !errors.Is(err, ErrInvalid) {
		t.Fatal("unknown profile", err)
	}
	if item, err = f.p.SetAgentRuntime(f.ctx, workspace, 2, selection); err != nil || item.(map[string]any)["revision"] != 2 {
		t.Fatal("no-op CAS", err)
	}
	if *read(f.assignment.ID).Runtime != *source.Runtime {
		t.Fatal("queued source changed")
	}
	// Finish/reclaim the old attempt, then continue after Workspace/env drift.
	f.finish(t, nil, "succeeded")
	if err = f.p.ReleaseSlots(f.ctx, "m10-partial", nil); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WHIPPET_AI_BASE_URL", "https://changed.example/v1")
	continued, err := f.p.ContinueAuthor(f.ctx, f.assignment.ID, f.sessionID, f.revision)
	if err != nil {
		t.Fatal("continue", err)
	}
	if *read(continued.Run.ID).Runtime != *source.Runtime {
		t.Fatal("continuation reselected runtime")
	}
	replay, err := f.p.ContinueAuthor(f.ctx, f.assignment.ID, f.sessionID, f.revision)
	if err != nil || replay.Run.ID != continued.Run.ID {
		t.Fatal("continue replay", err)
	}
	assignment, err := f.p.Claim(f.ctx, "m10-partial", 1)
	if err != nil || assignment == nil || assignment.ID != continued.Run.ID || *assignment.Author.Runtime != *source.Runtime {
		t.Fatal("dispatch drift", err)
	}
	// A new Run uses the current profile, while its older counterpart stays fixed.
	t.Setenv("WHIPPET_AI_BASE_URL", "https://opencode.ai/inference/go/openai/v1")
	other, err := f.p.CreateTest(f.ctx, workspace, "fresh", "")
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := f.p.StartEditingSession(f.ctx, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := f.p.CreateAuthor(f.ctx, other.ID, s.ID, "describe", s.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	newInput := read(fresh.Run.ID)
	if newInput.Runtime.Engine != "vercel" || jsonText(newInput.Budget) != jsonText(source.Budget) {
		t.Fatal("new Run policy/budget")
	}
	interview, err := f.p.CreateWorkspaceAuthor(f.ctx, workspace, "plan", 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if read(interview.Run.ID).Runtime.Engine != "builtin" {
		t.Fatal("per-skill override")
	}
	// Management route rejects key/endpoint injection and duplicate keys.
	admin := NewID()
	handler := NewAPI(f.p, nil, nil, NewID(), slog.New(slog.NewTextHandler(io.Discard, nil))).WithAdminAccess(admin, "").Handler(nil)
	for _, body := range []string{`{"revision":2,"profileId":"builtin","skillProfiles":{},"baseURL":"https://evil.example"}`, `{"revision":2,"profileId":"builtin","skillProfiles":{},"apiKey":"forbidden"}`, `{"revision":2,"profileId":"builtin","profileId":"vercel","skillProfiles":{}}`, `{"revision":2,"profileId":"builtin","skillProfiles":null}`} {
		r := httptest.NewRequest("PATCH", "/api/workspaces/"+workspace+"/agent-runtime", strings.NewReader(body))
		r.Header.Set("X-Whippet-Admin-Token", admin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("injection status %d", w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/api/workspaces/"+workspace+"/agent-runtime", nil)
	r.Header.Set("X-Whippet-Admin-Token", admin)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || strings.Contains(w.Body.String(), "baseURL") || strings.Contains(w.Body.String(), "apiKey") {
		t.Fatal("public profile descriptor")
	}
}
