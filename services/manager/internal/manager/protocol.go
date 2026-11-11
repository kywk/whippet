package manager

import (
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
	Kind              string          `json:"kind"`
	Script            string          `json:"script"`
	TimeoutMS         int64           `json:"timeoutMs"`
	Author            *AuthorTask     `json:"author,omitempty"`
	WorkspaceSettings json.RawMessage `json:"workspaceSettings,omitempty"`
}

type AuthorMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type AuthorTask struct {
	ConversationID string            `json:"conversationId"`
	BaseRevision   int64             `json:"baseRevision"`
	Messages       []AuthorMessage   `json:"messages"`
	Validation     *AuthorValidation `json:"validation,omitempty"`
}

type AuthorValidation struct {
	RunID  string `json:"runId"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type WorkerInput struct {
	RunID             string          `json:"runId"`
	AttemptID         string          `json:"attemptId"`
	Script            string          `json:"script"`
	TimeoutMS         int64           `json:"timeoutMs"`
	Kind              string          `json:"kind,omitempty"`
	Author            *AuthorTask     `json:"author,omitempty"`
	WorkspaceSettings json.RawMessage `json:"workspaceSettings,omitempty"`
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
