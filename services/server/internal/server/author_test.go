package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestAuthorContextPreservesCurrentTurnWithinBudget(t *testing.T) {
	current := strings.Repeat("測", 16000)
	if err := validateUserMessage(current); err != nil {
		t.Fatal("16000 Unicode characters must be accepted", err)
	}
	for _, invalid := range []string{"", " \n\t", current + "試", "invalid\x00message"} {
		if err := validateUserMessage(invalid); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid user message accepted: %v", err)
		}
	}
	context := authorContext([]ChatMessage{{"user", current}, {"assistant", strings.Repeat("舊", 30000)}, {"user", "older"}})
	if len(context) != 2 || context[1].Content != current || context[1].Role != "user" || utf8.RuneCountInString(context[0].Content) != 16000 {
		t.Fatal("current user turn was truncated or context budget exceeded")
	}
	newest := make([]ChatMessage, 20)
	for i := range newest {
		newest[i] = ChatMessage{"user", "message"}
	}
	if len(authorContext(newest)) != 12 {
		t.Fatal("context exceeded the 12-message cap")
	}
}

func TestAuthorPlanAppliesOnlyMatchingRevision(t *testing.T) {
	message, candidate, request := "updated the test", "new test script", true
	output := authorOutput{Message: &message, Script: &candidate, RequestValidation: &request}
	draft := Draft{Revision: 3, Script: "saved draft"}
	plan, err := planAuthorResult(draft, 3, output)
	if err != nil || !plan.changed || !plan.requestValidation || plan.script != candidate || plan.proposedScript == nil || *plan.proposedScript != candidate {
		t.Fatalf("matching result should apply and retain proposal for diff: %+v %v", plan, err)
	}
	plan, err = planAuthorResult(draft, 2, output)
	if err != nil || plan.changed || plan.requestValidation || plan.script != draft.Script || plan.proposedScript == nil || !strings.Contains(plan.message, "未自動套用") {
		t.Fatalf("human edit must prevent both application and validation: %+v %v", plan, err)
	}
	output.Script = &draft.Script
	plan, err = planAuthorResult(draft, 3, output)
	if err != nil || plan.changed || plan.proposedScript == nil || !plan.requestValidation {
		t.Fatal("unchanged proposal should preserve revision and remain available for diff")
	}
	output.Script = nil
	request = false
	plan, err = planAuthorResult(draft, 3, output)
	if err != nil || plan.changed || plan.proposedScript != nil || plan.requestValidation || plan.script != draft.Script {
		t.Fatal("a question without script must preserve the saved draft")
	}
	request = true
	if _, err := planAuthorResult(Draft{Revision: 1}, 1, output); err == nil {
		t.Fatal("empty draft must not enqueue invalid validation work")
	}
}

func TestAuthorResultReplayAndFailureRedaction(t *testing.T) {
	raw := "provider raw body with private data"
	for _, status := range []string{"failed", "timed_out", "cancelled"} {
		result, duplicate, err := authorResultDisposition("running", "", Result{Status: status, Error: raw})
		if err != nil || duplicate || result.Status != status || result.Error == "" || strings.Contains(result.Error, raw) {
			t.Fatalf("author error must be fixed and prevent success application: %+v %v", result, err)
		}
	}
	result, duplicate, err := authorResultDisposition("cancelling", "", Result{Status: "succeeded", Error: raw})
	if err != nil || duplicate || result.Status != "cancelled" || strings.Contains(result.Error, raw) {
		t.Fatal("cancellation must prevent applying a late successful candidate")
	}
	for _, terminal := range []string{"succeeded", "failed", "cancelled"} {
		// Invalid artifact and cancel can safely normalize a reported success.
		_, duplicate, err := authorResultDisposition(terminal, "succeeded", Result{Status: "succeeded"})
		if err != nil || !duplicate {
			t.Fatalf("replay would repeat revision/message/validation side effects: %s %v", terminal, err)
		}
	}
	if _, _, err := authorResultDisposition("succeeded", "succeeded", Result{Status: "failed"}); !errors.Is(err, ErrConflict) {
		t.Fatal("conflicting terminal result accepted")
	}
}

func TestAuthorOutputAndArtifactKindLimits(t *testing.T) {
	output, err := decodeAuthorOutput([]byte(`{"message":"請補充預期結果","requestValidation":false}`))
	if err != nil || output.Script != nil || *output.Message == "" {
		t.Fatal("author success must support a question without report or script")
	}
	for _, invalid := range []string{`{}`, `{"message":"x"}`, `{"message":null,"requestValidation":false}`,
		`{"message":"x","requestValidation":true} {}`, `{"message":"x","requestValidation":false,"error":"raw body"}`,
		`{"message":"\u0000","requestValidation":false}`} {
		if _, err := decodeAuthorOutput([]byte(invalid)); err == nil {
			t.Fatalf("invalid author output accepted: %s", invalid)
		}
	}
	for _, kind := range []string{"author", "run", "validation"} {
		for _, name := range []string{"author.json", "report.html", "results.json"} {
			expected := (kind == "author") == (name == "author.json")
			if artifactAllowed(kind, name) != expected {
				t.Fatalf("cross-kind artifact access: %s %s", kind, name)
			}
		}
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := files.Save(NewID(), NewID(), "author.json", strings.NewReader(strings.Repeat("x", int(MaxAuthorArtifactBytes)+1))); !errors.Is(err, ErrInvalid) {
		t.Fatalf("author artifact size cap not enforced: %v", err)
	}
}

func TestDispatchAuthorAndValidationUseDistinctKinds(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(newFlowStore(), log)
	peer := &recordPeer{}
	session := &Session{managerID: "manager-test", peer: peer, sent: map[string]time.Time{}}
	input := &AuthorInput{ConversationID: NewID(), BaseRevision: 2, Messages: []ChatMessage{{"user", "update"}}}
	input.Validation = validationSnapshot(NewID(), "failed", "expected alpha list item to be visible")
	assignment := Assignment{Run: Run{ID: NewID(), Kind: "author"}, AttemptID: NewID(), Script: "saved script", TimeoutMS: authorTimeoutMS, Author: input}
	if err := engine.send(session, assignment, "dispatch"); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Kind      string       `json:"kind"`
		TimeoutMS int          `json:"timeoutMs"`
		Author    *AuthorInput `json:"author"`
	}
	if err := json.Unmarshal(peer.messages[0].Payload, &payload); err != nil || payload.Kind != "author" || payload.TimeoutMS != 180000 || payload.Author == nil || payload.Author.BaseRevision != 2 || payload.Author.Validation == nil || payload.Author.Validation.RunID != input.Validation.RunID {
		t.Fatalf("invalid author dispatch: %+v %v", payload, err)
	}
	assignment.Kind, assignment.Author, assignment.AttemptID = "validation", nil, NewID()
	if err := engine.send(session, assignment, "dispatch"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(peer.messages[1].Payload), `"author"`) || !strings.Contains(string(peer.messages[1].Payload), `"kind":"run"`) {
		t.Fatal("validation must retain M2 run dispatch without author data")
	}
}

func TestAuthorValidationSnapshotIsBoundedAndOptional(t *testing.T) {
	fullError := strings.Repeat("錯", 4001)
	snapshot := validationSnapshot(NewID(), "failed", fullError)
	if utf8.RuneCountInString(snapshot.Error) != 4000 || snapshot.Status != "failed" || utf8.RuneCountInString(fullError) != 4001 {
		t.Fatal("validation error must be a fixed 4000-character snapshot")
	}
	input := AuthorInput{ConversationID: NewID(), BaseRevision: 2, Messages: []ChatMessage{{"user", "fix this"}}, Validation: snapshot}
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	assignment := Assignment{Run: Run{Kind: "author"}}
	if err := decodeAssignmentAuthor(&assignment, string(data)); err != nil || assignment.Author.Validation == nil || assignment.Author.Validation.Error != snapshot.Error {
		t.Fatalf("persisted author snapshot lost validation context: %v", err)
	}
	input.Validation = nil
	legacy, err := json.Marshal(input)
	if err != nil || strings.Contains(string(legacy), `"validation"`) {
		t.Fatal("validation must remain optional for old payloads")
	}
	assignment.Author = nil
	if err := decodeAssignmentAuthor(&assignment, string(legacy)); err != nil || assignment.Author.Validation != nil {
		t.Fatal("old author snapshots must decode without validation context")
	}
}

type conversationHTTPStore struct{ Store }

func (conversationHTTPStore) Conversation(_ context.Context, testID, sessionID string) (Conversation, error) {
	revision := 2
	base, proposed := "original script", "generated script"
	return Conversation{ID: NewID(), TestID: testID, Messages: []Message{{ID: NewID(), Role: "assistant", Content: "updated", BaseRevision: &revision, AppliedRevision: &revision, BaseScript: &base, ProposedScript: &proposed}}}, nil
}

func (conversationHTTPStore) CreateAuthor(_ context.Context, testID, _sessionID, _ string, revision int) (AuthorSubmission, error) {
	if revision != 2 {
		return AuthorSubmission{}, ErrConflict
	}
	return AuthorSubmission{Run: Run{ID: NewID(), TestID: testID, Kind: "author", Status: "queued", DraftRevision: &revision}, ConversationID: NewID()}, nil
}

func TestConversationHTTPAndStoredDiffFields(t *testing.T) {
	store := conversationHTTPStore{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(store, nil, NewEngine(store, log), "token", log).Handler(nil)
	id := NewID()
	r := httptest.NewRequest("GET", "/api/tests/"+id+"/conversation", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"baseScript":"original script"`) || !strings.Contains(w.Body.String(), `"proposedScript":"generated script"`) {
		t.Fatal("reopened conversation must expose original and applied proposal for diff", w.Body.String())
	}
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{"editingSessionId":"00000000-0000-4000-8000-000000000001","content":"修改測試","revision":2}`, 202},
		{`{"editingSessionId":"00000000-0000-4000-8000-000000000001","content":"修改測試","revision":1}`, 409},
		{`{"content":"  ","revision":2}`, 400},
		{`{"content":"修改測試","revision":0}`, 400},
	} {
		r := httptest.NewRequest("POST", "/api/tests/"+id+"/messages", strings.NewReader(tc.body))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("message expected %d, got %d %s", tc.status, w.Code, w.Body)
		}
	}
}
