package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var (
	ErrNotFound = errors.New("resource not found")
	ErrConflict = errors.New("state conflict")
	ErrInvalid  = errors.New("invalid input")
)

type Workspace struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	AuthorEngine string `json:"authorEngine"`
	WorkspaceSettings
	Lifecycle             string                `json:"lifecycle"`
	AuthorizationRevision int64                 `json:"authorizationRevision"`
	ScopeStatus           string                `json:"scopeStatus"`
	Settings              *WorkspaceConfig      `json:"settings"`
	ConversationID        string                `json:"conversationId"`
	ActiveRunID           *string               `json:"activeRunId"`
	CurrentProposal       *WorkspaceProposal    `json:"currentProposal"`
	Roles                 []RoleRef             `json:"roles"`
	SecretsAvailable      bool                  `json:"secretsAvailable"`
	ExecutionAvailable    bool                  `json:"executionAvailable"`
	UnavailableReason     *string               `json:"unavailableReason"`
	Capabilities          WorkspaceCapabilities `json:"capabilities"`
}

type Test struct {
	Kind                 string                `json:"kind"`
	Slug                 *string               `json:"slug,omitempty"`
	ID                   string                `json:"id"`
	WorkspaceID          string                `json:"workspaceId"`
	Name                 string                `json:"name"`
	Description          string                `json:"description"`
	PublishedVersionID   *string               `json:"publishedVersionId"`
	ActiveEditingSession *ActiveEditingSession `json:"activeEditingSession"`
}

type Run struct {
	AuthorEngine          string         `json:"authorEngine"`
	AuthorPartial         *AuthorPartial `json:"authorPartial,omitempty"`
	ScriptOrigin          string         `json:"scriptOrigin"`
	authorizationRevision *int64
	scopeProposalID       *string
	WorkspaceID           string             `json:"workspaceId"`
	ID                    string             `json:"id"`
	TestID                *string            `json:"testId"`
	WorkspaceContext      *WorkspaceContext  `json:"workspaceContext,omitempty"`
	Status                string             `json:"status"`
	CreatedAt             time.Time          `json:"createdAt"`
	StartedAt             *time.Time         `json:"startedAt,omitempty"`
	FinishedAt            *time.Time         `json:"finishedAt,omitempty"`
	Error                 string             `json:"error,omitempty"`
	ReportURL             string             `json:"reportUrl,omitempty"`
	Kind                  string             `json:"kind"`
	DraftRevision         *int               `json:"draftRevision,omitempty"`
	VersionID             *string            `json:"versionId,omitempty"`
	WorkspaceSettings     *WorkspaceSettings `json:"workspaceSettings,omitempty"`
	EditingSessionID      *string            `json:"editingSessionId"`
	AuthorMode            string             `json:"authorMode,omitempty"`
	ProgressEvents        []string           `json:"progressEvents,omitempty"`
}

type Draft struct {
	Module            *Module            `json:"module,omitempty"`
	Stages            []Stage            `json:"stages,omitempty"`
	ScriptOrigin      string             `json:"scriptOrigin"`
	WorkspaceContext  *WorkspaceContext  `json:"workspaceContext,omitempty"`
	EditingSessionID  string             `json:"editingSessionId"`
	TestID            string             `json:"testId"`
	Revision          int                `json:"revision"`
	Script            string             `json:"script"`
	UpdatedAt         time.Time          `json:"updatedAt"`
	ValidationRunID   *string            `json:"validationRunId,omitempty"`
	ValidationStatus  string             `json:"validationStatus,omitempty"`
	ReportURL         string             `json:"reportUrl,omitempty"`
	WorkspaceSettings *WorkspaceSettings `json:"workspaceSettings,omitempty"`
}

type Version struct {
	Module            *Module            `json:"module,omitempty"`
	Stages            []Stage            `json:"stages,omitempty"`
	ScriptOrigin      string             `json:"scriptOrigin"`
	WorkspaceContext  *WorkspaceContext  `json:"workspaceContext,omitempty"`
	Description       *string            `json:"description"`
	BackgroundSummary *string            `json:"backgroundSummary"`
	SummaryRunID      *string            `json:"summaryRunId"`
	EditingSessionID  *string            `json:"editingSessionId"`
	ID                string             `json:"id"`
	TestID            string             `json:"testId"`
	Revision          int                `json:"revision"`
	Script            string             `json:"script"`
	CreatedAt         time.Time          `json:"createdAt"`
	ValidationRunID   *string            `json:"validationRunId"`
	WorkspaceSettings *WorkspaceSettings `json:"workspaceSettings,omitempty"`
}

type Conversation struct {
	EditingSessionID string    `json:"editingSessionId"`
	ID               string    `json:"id"`
	TestID           string    `json:"testId"`
	Messages         []Message `json:"messages"`
	ActiveRunID      *string   `json:"activeRunId,omitempty"`
}

type Message struct {
	ID              string    `json:"id"`
	Role            string    `json:"role"`
	Content         string    `json:"content"`
	CreatedAt       time.Time `json:"createdAt"`
	RunID           *string   `json:"runId,omitempty"`
	BaseRevision    *int      `json:"baseRevision,omitempty"`
	BaseScript      *string   `json:"baseScript,omitempty"`
	AppliedRevision *int      `json:"appliedRevision,omitempty"`
	ProposedScript  *string   `json:"proposedScript,omitempty"`
	ValidationRunID *string   `json:"validationRunId,omitempty"`
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type AuthorInput struct {
	ModuleSummary       *ModuleSummarySnapshot `json:"moduleSummary,omitempty"`
	Batch               *AuthorBatch           `json:"batch,omitempty"`
	Platform            *AuthorPlatform        `json:"platform,omitempty"`
	Skills              []SkillSnapshot        `json:"skills,omitempty"`
	Budget              *AuthorBudget          `json:"budget,omitempty"`
	Model               *AuthorModel           `json:"model,omitempty"`
	ToolRegistryVersion string                 `json:"toolRegistryVersion,omitempty"`
	ToolRegistrySHA256  string                 `json:"toolRegistrySha256,omitempty"`
	SkillID             string                 `json:"skillId,omitempty"`
	SkillVersion        string                 `json:"skillVersion,omitempty"`
	AllowedTools        []string               `json:"allowedTools"`
	EditingSessionID    string                 `json:"editingSessionId,omitempty"`
	ContextRevision     int64                  `json:"contextRevision"`
	SourceVersion       *SourceVersion         `json:"sourceVersion"`
	ConversationSummary *string                `json:"conversationSummary"`
	ValidationEvidence  *ValidationEvidence    `json:"validationEvidence,omitempty"`
	ConversationID      string                 `json:"conversationId"`
	BaseRevision        int                    `json:"baseRevision"`
	Messages            []ChatMessage          `json:"messages"`
	Validation          *AuthorValidation      `json:"validation,omitempty"`
	History             *AuthorHistory         `json:"history,omitempty"`
}

type AuthorValidation struct {
	RunID  string `json:"runId"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type AuthorSubmission struct {
	Run            Run    `json:"run"`
	ConversationID string `json:"conversationId"`
}

func Terminal(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "timed_out", "interrupted":
		return true
	}
	return false
}

type Assignment struct {
	Files []RunFile
	Run
	ManagerID string
	AttemptID string
	Script    string
	TimeoutMS int
	Acked     bool
	Author    *AuthorInput
}

func stringPointer(value string) *string { return &value }
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (a AuthorInput) MarshalJSON() ([]byte, error) {
	type wire AuthorInput
	if a.SkillID == "workspace-author" {
		return json.Marshal(struct {
			wire
			EditingSessionID *string `json:"editingSessionId"`
		}{wire(a), nil})
	}
	return json.Marshal(wire(a))
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

type ArtifactInfo struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
	URL         string `json:"url"`
}

// Store is the persistent business boundary; PostgreSQL owns queue order and attempts.
type Store interface {
	Ping(context.Context) error
	Workspaces(context.Context) ([]Workspace, error)
	Workspace(context.Context, string) (Workspace, error)
	PatchWorkspace(context.Context, string, WorkspacePatch) (Workspace, error)
	CreateWorkspace(context.Context, string) (Workspace, error)
	WorkspaceConversation(context.Context, string) (WorkspaceConversation, error)
	CreateWorkspaceAuthor(context.Context, string, string, int, int64) (AuthorSubmission, error)
	WorkspaceProposal(context.Context, string, string) (WorkspaceProposal, error)
	ActWorkspaceProposal(context.Context, string, string, string, int) (Workspace, WorkspaceProposal, error)
	SaveWorkspaceCredentials(context.Context, string, string, int, credentialValues) (RoleRef, error)
	RevokeWorkspaceCredentials(context.Context, string, string, int) (RoleRef, error)
	ResolveWorkspaceCredentials(context.Context, string, string, string, CredentialRequest) (CredentialResolution, error)
	ConversationHistory(context.Context, string, string, string, *string) (HistoryPage, error)
	Tests(context.Context, string) ([]Test, error)
	Test(context.Context, string) (Test, error)
	CreateTest(context.Context, string, string, string) (Test, error)
	Draft(context.Context, string) (Draft, error)
	SaveDraft(context.Context, string, string, int, string) (Draft, error)
	ValidateDraft(context.Context, string, string, int) (Run, error)
	Publish(context.Context, string, string, int, string, bool) (Version, error)
	Versions(context.Context, string) ([]Version, error)
	Conversation(context.Context, string, string) (Conversation, error)
	CreateAuthor(context.Context, string, string, string, int) (AuthorSubmission, error)
	StartEditingSession(context.Context, string) (EditingSession, bool, error)
	EditingSession(context.Context, string, string) (*EditingSession, error)
	DiscardEditingSession(context.Context, string, string, int) (EditingSession, error)
	CreateSummary(context.Context, string, string, int, string) (Run, error)
	CreateRun(context.Context, string) (Run, error)
	Runs(context.Context, string) ([]Run, error)
	Run(context.Context, string) (Run, error)
	LiveTarget(context.Context, string) (LiveTarget, error)
	Cancel(context.Context, string) (Run, error)
	RegisterManager(context.Context, string, int) error
	Assignments(context.Context, string) ([]Assignment, error)
	Claim(context.Context, string, int) (*Assignment, error)
	Acknowledge(context.Context, string, string, string) error
	AddEvent(context.Context, string, string, string, Event) error
	Complete(context.Context, string, string, string, Result) error
	ReleaseSlots(context.Context, string, []ActiveAttempt) error
	UploadAllowed(context.Context, string, string, string) error
	SaveArtifact(context.Context, Artifact) error
	Artifact(context.Context, string, string) (Artifact, error)
	ListArtifacts(context.Context, string) ([]ArtifactInfo, error)
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

func validArtifact(name string) bool {
	return name == "report.html" || name == "results.json" || name == "author.json" || isScreenshotArtifact(name) || isEvidenceArtifact(name)
}

var screenshotNamePattern = regexp.MustCompile(`^data/[0-9a-f]{40}[.]png$`)
var evidenceNamePattern = regexp.MustCompile(`^data/[0-9a-f]{40}[.](zip|md)$`)

func isScreenshotArtifact(name string) bool { return screenshotNamePattern.MatchString(name) }
func isEvidenceArtifact(name string) bool   { return evidenceNamePattern.MatchString(name) }

func artifactAllowed(kind, name string) bool {
	if kind == "author" {
		return name == "author.json"
	}
	return (kind == "run" || kind == "validation") && (name == "report.html" || name == "results.json" || isScreenshotArtifact(name) || isEvidenceArtifact(name))
}
