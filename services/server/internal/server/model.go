package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var (
	ErrNotFound = errors.New("resource not found")
	ErrConflict = errors.New("state conflict")
	ErrInvalid  = errors.New("invalid input")
)

type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Test struct {
	ID                 string  `json:"id"`
	WorkspaceID        string  `json:"workspaceId"`
	Name               string  `json:"name"`
	Description        string  `json:"description"`
	PublishedVersionID *string `json:"publishedVersionId"`
}

type Run struct {
	ID         string     `json:"id"`
	TestID     string     `json:"testId"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Error      string     `json:"error,omitempty"`
	ReportURL  string     `json:"reportUrl,omitempty"`
}

func Terminal(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "timed_out", "interrupted":
		return true
	}
	return false
}

type Assignment struct {
	Run
	ManagerID string
	AttemptID string
	Script    string
	TimeoutMS int
	Acked     bool
}

type ActiveAttempt struct {
	RunID     string `json:"runId"`
	AttemptID string `json:"attemptId"`
}

type Event struct {
	EventID string `json:"eventId"`
	Kind    string `json:"kind"`
	Message string `json:"message,omitempty"`
}

type Result struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

func (r Result) Valid() bool {
	return r.Status == "succeeded" || r.Status == "failed" || r.Status == "timed_out" || r.Status == "cancelled"
}

type Envelope struct {
	ProtocolVersion int             `json:"protocolVersion"`
	MessageID       string          `json:"messageId"`
	Type            string          `json:"type"`
	ManagerID       string          `json:"managerId"`
	RunID           string          `json:"runId,omitempty"`
	AttemptID       string          `json:"attemptId,omitempty"`
	Payload         json.RawMessage `json:"payload"`
}

func NewEnvelope(kind, managerID, runID, attemptID string, payload any) Envelope {
	data, _ := json.Marshal(payload)
	return Envelope{1, NewID(), kind, managerID, runID, attemptID, data}
}

type Artifact struct {
	RunID      string
	AttemptID  string
	Name       string
	StorageKey string
	Size       int64
	SHA256     string
}

// Store is the persistent business boundary; PostgreSQL owns queue order and attempts.
type Store interface {
	Ping(context.Context) error
	Workspaces(context.Context) ([]Workspace, error)
	Tests(context.Context, string) ([]Test, error)
	Test(context.Context, string) (Test, error)
	CreateRun(context.Context, string) (Run, error)
	Runs(context.Context, string) ([]Run, error)
	Run(context.Context, string) (Run, error)
	Cancel(context.Context, string) (Run, error)
	RegisterManager(context.Context, string, int) error
	Assignments(context.Context, string) ([]Assignment, error)
	Claim(context.Context, string, int) (*Assignment, error)
	Acknowledge(context.Context, string, string, string) error
	AddEvent(context.Context, string, string, string, Event) error
	Complete(context.Context, string, string, string, Result) error
	ReleaseSlots(context.Context, string, []ActiveAttempt) error
	UploadAllowed(context.Context, string, string) error
	SaveArtifact(context.Context, Artifact) error
	Artifact(context.Context, string, string) (Artifact, error)
}

func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Errorf("generate UUID: %w", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func ValidID(id string) bool {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		return false
	}
	raw := id[:8] + id[9:13] + id[14:18] + id[19:23] + id[24:]
	_, err := hex.DecodeString(raw)
	return err == nil
}

func validArtifact(name string) bool { return name == "report.html" || name == "results.json" }
