package manager

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"unicode/utf8"
)

type registryTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Side        string          `json:"side"`
	Effect      string          `json:"effect"`
	Limits      struct {
		TimeoutMS      int64 `json:"timeoutMs"`
		MaxInputBytes  int64 `json:"maxInputBytes"`
		MaxOutputBytes int64 `json:"maxOutputBytes"`
	} `json:"limits"`
}
type toolRegistry struct {
	SchemaVersion int            `json:"schemaVersion"`
	Version       string         `json:"version"`
	Tools         []registryTool `json:"tools"`
	SHA256        string         `json:"-"`
}

var errCapability = errors.New("invalid author capability snapshot")
var capabilityID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
var capabilityHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func loadToolRegistry() (*toolRegistry, error) {
	path := os.Getenv("WHIPPET_TOOL_REGISTRY_PATH")
	if path == "" {
		_, source, _, ok := runtime.Caller(0)
		if !ok {
			return nil, errCapability
		}
		path = filepath.Join(filepath.Dir(source), "../../../../contracts/tools/registry.json")
	}
	if !filepath.IsAbs(path) {
		return nil, errCapability
	}
	stat, err := os.Lstat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 1<<20 {
		return nil, errCapability
	}
	raw, err := os.ReadFile(path)
	if err != nil || !utf8.Valid(raw) || !exactWorkspaceObject(raw, "schemaVersion", "version", "tools") {
		return nil, errCapability
	}
	var registry toolRegistry
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&registry) != nil || registry.SchemaVersion != 1 || registry.Version == "" || registry.Tools == nil {
		return nil, errCapability
	}
	seen := map[string]bool{}
	for _, tool := range registry.Tools {
		if tool.Name == "" || seen[tool.Name] || tool.Description == "" || tool.Side != "worker" && tool.Side != "server" ||
			tool.Effect != "read" && tool.Effect != "candidate" && tool.Effect != "browser" && tool.Effect != "queue" ||
			tool.Limits.TimeoutMS <= 0 || tool.Limits.MaxInputBytes <= 0 || tool.Limits.MaxOutputBytes <= 0 || !json.Valid(tool.InputSchema) {
			return nil, errCapability
		}
		if _, err := parseToolSchema(tool.InputSchema); err != nil {
			return nil, errCapability
		}
		seen[tool.Name] = true
	}
	registry.SHA256 = fmt.Sprintf("%x", sha256.Sum256(raw))
	return &registry, nil
}

type skillPin struct {
	ID              string            `json:"id"`
	Version         string            `json:"version"`
	SHA256          string            `json:"sha256"`
	ManifestSHA256  string            `json:"manifestSha256"`
	ReferenceHashes map[string]string `json:"referenceHashes"`
}
type skillBudget struct {
	MaxOutputTokens  *int64 `json:"maxOutputTokens,omitempty"`
	MaxModelRequests int64  `json:"maxModelRequests"`
	MaxToolCalls     int64  `json:"maxToolCalls"`
	MaxDurationMS    int64  `json:"maxDurationMs"`
}
type skillModel struct {
	Provider        string `json:"provider"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoningEffort"`
}

// Nil means legacy; any partial v10 pin fails closed before dispatch.
func validCapabilitySnapshot(a *AuthorTask) (*toolRegistry, error) {
	if a == nil {
		return nil, errCapability
	}
	present := len(a.Skills) > 0 || len(a.Budget) > 0 || len(a.Model) > 0 || a.ToolRegistryVersion != nil || a.ToolRegistrySHA256 != nil
	if !present {
		return nil, nil
	}
	if len(a.Skills) == 0 || len(a.Budget) == 0 || len(a.Model) == 0 || a.ToolRegistryVersion == nil || a.ToolRegistrySHA256 == nil || a.SkillID == nil || a.SkillVersion == nil {
		return nil, errCapability
	}
	registry, err := loadToolRegistry()
	if err != nil || *a.ToolRegistryVersion != registry.Version || *a.ToolRegistrySHA256 != registry.SHA256 {
		return nil, errCapability
	}
	var rawPins []json.RawMessage
	if json.Unmarshal(a.Skills, &rawPins) != nil || len(rawPins) < 1 || len(rawPins) > 16 {
		return nil, errCapability
	}
	seen := map[string]bool{}
	previous := ""
	for i, raw := range rawPins {
		var pin skillPin
		if !exactWorkspaceObject(raw, "id", "version", "sha256", "manifestSha256", "referenceHashes") || json.Unmarshal(raw, &pin) != nil || !capabilityID.MatchString(pin.ID) || seen[pin.ID] || pin.Version == "" || !capabilityHash.MatchString(pin.SHA256) || !capabilityHash.MatchString(pin.ManifestSHA256) || pin.ReferenceHashes == nil {
			return nil, errCapability
		}
		if i == 0 && (pin.ID != *a.SkillID || pin.Version != *a.SkillVersion) {
			return nil, errCapability
		}
		if i > 0 {
			if pin.ID <= previous {
				return nil, errCapability
			}
			previous = pin.ID
		}
		for id, hash := range pin.ReferenceHashes {
			if !capabilityID.MatchString(id) || !capabilityHash.MatchString(hash) {
				return nil, errCapability
			}
		}
		seen[pin.ID] = true
	}
	budgetFields, validFields := uniqueBudgetFields(a.Budget)
	if !validFields {
		return nil, errCapability
	}
	for _, value := range budgetFields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, errCapability
		}
	}
	var budget skillBudget
	var model skillModel
	if !(exactWorkspaceObject(a.Budget, "maxModelRequests", "maxToolCalls", "maxDurationMs") || exactWorkspaceObject(a.Budget, "maxModelRequests", "maxToolCalls", "maxDurationMs", "maxOutputTokens")) || json.Unmarshal(a.Budget, &budget) != nil || budget.MaxModelRequests < 1 || budget.MaxToolCalls < 0 || budget.MaxDurationMS < 1 || budget.MaxModelRequests > 9007199254740991 || budget.MaxToolCalls > 9007199254740991 || budget.MaxDurationMS > 9007199254740991 ||
		!exactWorkspaceObject(a.Model, "provider", "model", "reasoningEffort") || json.Unmarshal(a.Model, &model) != nil || model.Provider != "opencode" || model.Model == "" || model.ReasoningEffort != "low" && model.ReasoningEffort != "medium" && model.ReasoningEffort != "high" && model.ReasoningEffort != "xhigh" {
		return nil, errCapability
	}
	if budget.MaxOutputTokens != nil && (*budget.MaxOutputTokens < 1 || *budget.MaxOutputTokens > 16384 || *budget.MaxOutputTokens > 8192 && *a.SkillID != "module-authoring") {
		return nil, errCapability
	}
	return registry, nil
}

// Budget alone accepts two exact shapes; duplicate keys cannot hide an override.
func uniqueBudgetFields(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	for d.More() {
		token, err = d.Token()
		key, ok := token.(string)
		if err != nil || !ok {
			return nil, false
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, false
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, false
		}
		fields[key] = value
	}
	if _, err = d.Token(); err != nil || d.Decode(new(any)) != io.EOF {
		return nil, false
	}
	return fields, true
}
