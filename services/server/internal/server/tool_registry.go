package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

type ToolLimits struct {
	TimeoutMS      int `json:"timeoutMs"`
	MaxInputBytes  int `json:"maxInputBytes"`
	MaxOutputBytes int `json:"maxOutputBytes"`
}
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Side        string          `json:"side"`
	Effect      string          `json:"effect"`
	Limits      ToolLimits      `json:"limits"`
}
type ToolRegistry struct {
	SchemaVersion int              `json:"schemaVersion"`
	Version       string           `json:"version"`
	Tools         []ToolDefinition `json:"tools"`
	SHA256        string           `json:"-"`
}
type SkillSnapshot struct {
	ID              string            `json:"id"`
	Version         string            `json:"version"`
	SHA256          string            `json:"sha256"`
	ManifestSHA256  string            `json:"manifestSha256"`
	ReferenceHashes map[string]string `json:"referenceHashes"`
}
type AuthorBudget struct {
	MaxModelRequests int `json:"maxModelRequests"`
	MaxToolCalls     int `json:"maxToolCalls"`
	MaxDurationMS    int `json:"maxDurationMs"`
}
type AuthorModel struct {
	Provider        string `json:"provider"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoningEffort"`
}

func repositoryFile(parts ...string) string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return ""
	}
	return filepath.Join(append([]string{filepath.Dir(file), "../../../.."}, parts...)...)
}
func loadToolRegistry() (*ToolRegistry, error) {
	path := os.Getenv("WHIPPET_TOOL_REGISTRY_PATH")
	if path == "" {
		path = repositoryFile("contracts", "tools", "registry.json")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("tool registry unavailable")
	}
	return decodeToolRegistry(data)
}
func decodeToolRegistry(data []byte) (*ToolRegistry, error) {
	var r ToolRegistry
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(&r) != nil || dec.Decode(new(any)) != io.EOF || r.SchemaVersion != 1 || r.Version == "" || len(r.Tools) == 0 {
		return nil, ErrInvalid
	}
	seen := map[string]bool{}
	for _, t := range r.Tools {
		if t.Name == "" || seen[t.Name] || (t.Side != "server" && t.Side != "worker") || (t.Effect != "read" && t.Effect != "candidate" && t.Effect != "browser" && t.Effect != "queue") || t.Limits.TimeoutMS < 1 || t.Limits.MaxInputBytes < 1 || t.Limits.MaxOutputBytes < 1 || !json.Valid(t.InputSchema) {
			return nil, ErrInvalid
		}
		seen[t.Name] = true
	}
	r.SHA256 = scriptHash(string(data))
	return &r, nil
}
func (r *ToolRegistry) tool(name string) (ToolDefinition, bool) {
	for _, t := range r.Tools {
		if t.Name == name {
			return t, true
		}
	}
	return ToolDefinition{}, false
}

// No fallback on partial snapshots. Loading references is a separate Worker
// responsibility, but Server binds capabilities to the exact packaged registry.
func validateToolSnapshot(input AuthorInput, registry *ToolRegistry, name string) error {
	if registry == nil || input.ToolRegistryVersion != registry.Version || input.ToolRegistrySHA256 != registry.SHA256 || len(input.Skills) == 0 || input.Budget == nil || input.Model == nil {
		return ErrHistoryUnavailable
	}
	if input.Budget.MaxModelRequests < 1 || input.Budget.MaxToolCalls < 0 || input.Budget.MaxDurationMS < 1 || input.Model.Provider != "opencode" || input.Model.Model == "" {
		return ErrHistoryUnavailable
	}
	if input.Skills[0].ID != input.SkillID || input.Skills[0].Version != input.SkillVersion {
		return ErrHistoryUnavailable
	}
	seen := map[string]bool{}
	for _, skill := range input.Skills {
		if skill.ID == "" || skill.Version == "" || !sha256Hex(skill.SHA256) || !sha256Hex(skill.ManifestSHA256) || skill.ReferenceHashes == nil || seen[skill.ID] {
			return ErrHistoryUnavailable
		}
		seen[skill.ID] = true
		for _, hash := range skill.ReferenceHashes {
			if !sha256Hex(hash) {
				return ErrHistoryUnavailable
			}
		}
	}
	for i := 2; i < len(input.Skills); i++ {
		if input.Skills[i-1].ID >= input.Skills[i].ID {
			return ErrHistoryUnavailable
		}
	}
	allowed := false
	for _, tool := range input.AllowedTools {
		if _, ok := registry.tool(tool); !ok {
			return ErrHistoryUnavailable
		}
		if tool == name {
			allowed = true
		}
	}
	if !allowed {
		return ErrHistoryUnavailable
	}
	return nil
}
func sha256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func hasToolSnapshot(input AuthorInput) bool {
	return input.Skills != nil || input.Budget != nil || input.Model != nil || input.ToolRegistryVersion != "" || input.ToolRegistrySHA256 != ""
}
