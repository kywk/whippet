package manager

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"regexp"
)

const maxScriptBytes = 2 << 20
const maxArtifactBytes = 64 << 20

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Envelope struct {
	ProtocolVersion int             `json:"protocolVersion"`
	MessageID       string          `json:"messageId"`
	Type            string          `json:"type"`
	ManagerID       string          `json:"managerId"`
	RunID           string          `json:"runId,omitempty"`
	AttemptID       string          `json:"attemptId,omitempty"`
	Payload         json.RawMessage `json:"payload"`
}

type Dispatch struct {
	ScriptOrigin      string          `json:"scriptOrigin,omitempty"`
	Kind              string          `json:"kind"`
	Script            string          `json:"script"`
	TimeoutMS         int64           `json:"timeoutMs"`
	Author            *AuthorTask     `json:"author,omitempty"`
	WorkspaceSettings json.RawMessage `json:"workspaceSettings,omitempty"`
	WorkspaceID       string          `json:"workspaceId,omitempty"`
	TestID            json.RawMessage `json:"testId,omitempty"`
	WorkspaceContext  json.RawMessage `json:"workspaceContext,omitempty"`
}

func (d *Dispatch) UnmarshalJSON(data []byte) error {
	type fields Dispatch
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode((*fields)(d))
}

type AuthorMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (m *AuthorMessage) UnmarshalJSON(data []byte) error {
	type fields AuthorMessage
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode((*fields)(m)); err != nil {
		return err
	}
	if !exactWorkspaceObject(data, "role", "content") {
		return fmt.Errorf("invalid author message fields")
	}
	var raw map[string]json.RawMessage
	json.Unmarshal(data, &raw)
	if bytes.Equal(raw["content"], []byte("null")) {
		return fmt.Errorf("invalid author message content")
	}
	return nil
}

type AuthorTask struct {
	ConversationID      string                    `json:"conversationId"`
	BaseRevision        int64                     `json:"baseRevision"`
	Messages            []AuthorMessage           `json:"messages"`
	Validation          *AuthorValidation         `json:"validation,omitempty"`
	SkillID             *string                   `json:"skillId,omitempty"`
	SkillVersion        *string                   `json:"skillVersion,omitempty"`
	AllowedTools        *[]string                 `json:"allowedTools,omitempty"`
	EditingSessionID    *string                   `json:"editingSessionId,omitempty"`
	ContextRevision     *int64                    `json:"contextRevision,omitempty"`
	SourceVersion       json.RawMessage           `json:"sourceVersion,omitempty"`
	ConversationSummary json.RawMessage           `json:"conversationSummary,omitempty"`
	ValidationEvidence  *AuthorValidationEvidence `json:"validationEvidence,omitempty"`
}

func (a *AuthorTask) UnmarshalJSON(data []byte) error {
	type fields AuthorTask
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode((*fields)(a)); err != nil {
		return err
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	for _, name := range []string{"skillId", "skillVersion", "allowedTools", "editingSessionId", "contextRevision", "sourceVersion", "conversationSummary", "validationEvidence"} {
		if _, exists := keys[name]; exists && (a.SkillID == nil || a.SkillVersion == nil) {
			return fmt.Errorf("incomplete author skill pin")
		}
	}
	if workspaceAuthor(a) && !bytes.Equal(bytes.TrimSpace(keys["editingSessionId"]), []byte("null")) {
		return fmt.Errorf("workspace author requires null editingSessionId")
	}
	if workspaceAuthor(a) {
		if _, exists := keys["validationEvidence"]; exists {
			return fmt.Errorf("workspace interview has no validation evidence")
		}
	}
	return nil
}

func (a AuthorTask) MarshalJSON() ([]byte, error) {
	type fields AuthorTask
	if workspaceAuthor(&a) {
		return json.Marshal(struct {
			fields
			EditingSessionID *string `json:"editingSessionId"`
		}{fields(a), a.EditingSessionID})
	}
	return json.Marshal(fields(a))
}

type AuthorValidationEvidence struct {
	RunID         string `json:"runId"`
	AttemptID     string `json:"attemptId"`
	DraftRevision int64  `json:"draftRevision"`
	ScriptHash    string `json:"scriptHash"`
	TimeoutMS     int64  `json:"timeoutMs"`
	Status        string `json:"status"`
	ReportsReady  bool   `json:"reportsReady"`
	Stats         struct {
		Expected   int64   `json:"expected"`
		Unexpected int64   `json:"unexpected"`
		Flaky      int64   `json:"flaky"`
		Skipped    int64   `json:"skipped"`
		Duration   float64 `json:"duration"`
	} `json:"stats"`
}

func (e *AuthorValidationEvidence) UnmarshalJSON(data []byte) error {
	type fields AuthorValidationEvidence
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode((*fields)(e)); err != nil {
		return err
	}
	var object map[string]json.RawMessage
	var stats map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || len(object) != 8 || json.Unmarshal(object["stats"], &stats) != nil || len(stats) != 5 {
		return fmt.Errorf("invalid validation evidence fields")
	}
	return nil
}

type AuthorValidation struct {
	RunID  string `json:"runId"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type WorkerInput struct {
	ScriptOrigin      string          `json:"scriptOrigin,omitempty"`
	RunID             string          `json:"runId"`
	AttemptID         string          `json:"attemptId"`
	Script            string          `json:"script"`
	TimeoutMS         int64           `json:"timeoutMs"`
	Kind              string          `json:"kind,omitempty"`
	Author            *AuthorTask     `json:"author,omitempty"`
	WorkspaceSettings json.RawMessage `json:"workspaceSettings,omitempty"`
	WorkspaceID       string          `json:"workspaceId,omitempty"`
	TestID            json.RawMessage `json:"testId,omitempty"`
	WorkspaceContext  json.RawMessage `json:"workspaceContext,omitempty"`
}

type Result struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

func (r Result) valid() bool {
	return r.Status == "succeeded" || r.Status == "failed" || r.Status == "timed_out" || r.Status == "cancelled"
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // Without OS entropy, generating protocol IDs is unsafe.
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func message(managerID, kind, runID, attemptID string, payload any) Envelope {
	data, err := json.Marshal(payload)
	if err != nil {
		panic(err) // Payloads are internal structs/maps containing JSON primitives.
	}
	return Envelope{1, newID(), kind, managerID, runID, attemptID, data}
}
