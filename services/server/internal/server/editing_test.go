package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestM7SummaryOutputAndEditRecapLimits(t *testing.T) {
	valid := `{"message":"請確認報告","description":"目的、前置條件、步驟與檢查","backgroundSummary":"非機密背景","name":" 新名稱 "}`
	if out, err := decodeSummaryOutput([]byte(valid)); err != nil || out.Name == nil || *out.Name != "新名稱" {
		t.Fatalf("valid summary: %+v %v", out, err)
	}
	for _, body := range []string{
		`{"message":"ok","description":"d","backgroundSummary":"b","script":"danger"}`,
		`{"message":"ok","description":"d","backgroundSummary":"b","requestValidation":true}`,
		`{"message":"ok","description":"","backgroundSummary":"b"}`,
		`{"message":"ok","description":"d"}`,
		`{"message":"ok","description":"d","backgroundSummary":"b","name":""}`,
		`{"message":"ok","description":"d","backgroundSummary":"` + strings.Repeat("b", 8193) + `"}`,
		valid + ` {}`,
	} {
		if _, err := decodeSummaryOutput([]byte(body)); err == nil {
			t.Fatal("invalid summary output accepted")
		}
	}
	if _, err := decodeAuthorOutput([]byte(`{"message":"完成","requestValidation":false,"conversationSummary":"` + strings.Repeat("a", 8192) + `"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := decodeAuthorOutput([]byte(`{"message":"完成","requestValidation":false,"conversationSummary":"` + strings.Repeat("a", 8193) + `"}`)); err == nil {
		t.Fatal("oversize conversation recap accepted")
	}
}

func TestM7SummaryBindingRejectsOldContextSessionAndSettings(t *testing.T) {
	validationID := NewID()
	s := EditingSession{ID: NewID(), TestID: NewID(), Status: "active", ConversationID: NewID(), ContextRevision: 2}
	settings := &WorkspaceSettings{Revision: 1, Sites: []WorkspaceSite{}, TimeoutMS: 60000}
	d := draftState{Draft: Draft{TestID: s.TestID, EditingSessionID: s.ID, Revision: 4, Script: "fixed script", WorkspaceSettings: settings, ValidationRunID: &validationID}, timeoutMS: 60000}
	d.hash = scriptHash(d.Script)
	input := editingAuthorInput(s, d, "acceptance-summary", []ChatMessage{})
	input.ValidationEvidence = &ValidationEvidence{RunID: validationID, AttemptID: NewID(), DraftRevision: 4, ScriptHash: d.hash, TimeoutMS: 60000, Status: "succeeded", ReportsReady: true, Stats: ValidationStats{Expected: 1}}
	if !summaryBindingMatches(s, d, input, d.Script, settings) {
		t.Fatal("valid summary binding rejected")
	}
	cases := []struct {
		name   string
		change func(*EditingSession, *AuthorInput, *WorkspaceSettings)
	}{
		{"closing", func(s *EditingSession, _ *AuthorInput, _ *WorkspaceSettings) { s.Status = "discarding" }},
		{"other_session", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) { a.EditingSessionID = NewID() }},
		{"other_conversation", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) { a.ConversationID = NewID() }},
		{"old_context", func(s *EditingSession, _ *AuthorInput, _ *WorkspaceSettings) { s.ContextRevision++ }},
		{"old_revision", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) { a.BaseRevision-- }},
		{"wrong_validation", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) { a.ValidationEvidence.RunID = NewID() }},
		{"missing_attempt", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) { a.ValidationEvidence.AttemptID = "" }},
		{"wrong_hash", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) {
			a.ValidationEvidence.ScriptHash = "other"
		}},
		{"wrong_timeout", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) { a.ValidationEvidence.TimeoutMS++ }},
		{"not_ready", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) {
			a.ValidationEvidence.ReportsReady = false
		}},
		{"wrong_settings", func(_ *EditingSession, _ *AuthorInput, w *WorkspaceSettings) {
			w.DefaultTestURL = "https://other.test/"
		}},
		{"wrong_skill", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) { a.SkillID = "test-author" }},
		{"wrong_skill_version", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) { a.SkillVersion = "2" }},
		{"write_tool", func(_ *EditingSession, a *AuthorInput, _ *WorkspaceSettings) {
			a.AllowedTools = []string{"update_draft"}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			session, a, w := s, input, *settings
			e := *input.ValidationEvidence
			a.ValidationEvidence = &e
			tc.change(&session, &a, &w)
			if summaryBindingMatches(session, d, a, d.Script, &w) {
				t.Fatal("stale or unauthorized summary accepted")
			}
		})
	}
	data, err := json.Marshal(input)
	if err != nil || strings.Contains(string(data), `"mode"`) || !strings.Contains(string(data), `"skillId":"acceptance-summary"`) || !strings.Contains(string(data), `"skillVersion":"1"`) || !strings.Contains(string(data), `"messages":[]`) || !strings.Contains(string(data), `"allowedTools":[]`) {
		t.Fatalf("wrong M7 wire shape: %s %v", data, err)
	}
}

type m7DiscardSweepStore struct {
	*flowStore
	calls int
}

func (s *m7DiscardSweepStore) FinalizeDiscardingSessions(context.Context) error {
	s.calls++
	return nil
}

func TestM7DiscardFinalizesWithoutConnectedManager(t *testing.T) {
	store := &m7DiscardSweepStore{flowStore: newFlowStore()}
	engine := NewEngine(store, nil)
	if err := engine.Tick(context.Background()); err != nil || store.calls != 1 {
		t.Fatalf("offline discard sweep skipped: calls=%d err=%v", store.calls, err)
	}
}
