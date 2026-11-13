package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

var ErrSkillUnavailable = errors.New("skill_unavailable")
var referencePath = regexp.MustCompile(`^references/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$`)
var modelName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$`)

type SkillReference struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type SkillManifest struct {
	ID           string           `json:"id"`
	Version      string           `json:"version"`
	DefaultTools []string         `json:"defaultTools"`
	Budget       AuthorBudget     `json:"budget"`
	Model        AuthorModel      `json:"model"`
	References   []SkillReference `json:"references"`
}

// Only explicit packaged files may be read. Never follow symlinks or accept a
// client/model path. Bound both stat and the actual read to survive file changes.
func readSkillFile(root, relative string, limit int64) ([]byte, error) {
	if !filepath.IsAbs(root) || strings.Contains(relative, "\\") || filepath.IsAbs(relative) {
		return nil, ErrSkillUnavailable
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		return nil, ErrSkillUnavailable
	}
	path := root
	parts := strings.Split(relative, "/")
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, ErrSkillUnavailable
		}
		path = filepath.Join(path, part)
		info, err = os.Lstat(path)
		if err != nil {
			return nil, ErrSkillUnavailable
		}
		if i < len(parts)-1 {
			if !info.IsDir() {
				return nil, ErrSkillUnavailable
			}
		} else if !info.Mode().IsRegular() || info.Size() > limit {
			return nil, ErrSkillUnavailable
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrSkillUnavailable
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		return nil, ErrSkillUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return nil, ErrSkillUnavailable
	}
	return data, nil
}
func loadSkill(root, id string, registry *ToolRegistry) (SkillManifest, SkillSnapshot, error) {
	var manifest SkillManifest
	pin := SkillSnapshot{ID: id, ReferenceHashes: map[string]string{}}
	if !moduleSlug.MatchString(id) {
		return manifest, pin, ErrSkillUnavailable
	}
	raw, err := readSkillFile(root, id+"/manifest.json", 64<<10)
	if err != nil {
		return manifest, pin, err
	}
	main, err := readSkillFile(root, id+"/SKILL.md", 8192)
	if err != nil {
		return manifest, pin, err
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || !requiredJSONFields(fields["budget"], "maxModelRequests", "maxToolCalls", "maxDurationMs") {
		return manifest, pin, ErrSkillUnavailable
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&manifest) != nil || dec.Decode(new(any)) != io.EOF || manifest.ID != id || manifest.Version == "" || manifest.DefaultTools == nil || manifest.References == nil || !validSkillBudget(manifest.Budget) || !validSkillModel(manifest.Model) {
		return manifest, pin, ErrSkillUnavailable
	}
	seen := map[string]bool{}
	for _, name := range manifest.DefaultTools {
		if _, ok := registry.tool(name); !ok || seen[name] {
			return manifest, pin, ErrSkillUnavailable
		}
		seen[name] = true
	}
	for _, ref := range manifest.References {
		if !moduleSlug.MatchString(ref.ID) || !referencePath.MatchString(ref.Path) || !sha256Hex(ref.SHA256) || pin.ReferenceHashes[ref.ID] != "" {
			return manifest, pin, ErrSkillUnavailable
		}
		data, err := readSkillFile(root, id+"/"+ref.Path, 128<<10)
		if err != nil || scriptHash(string(data)) != ref.SHA256 {
			return manifest, pin, ErrSkillUnavailable
		}
		pin.ReferenceHashes[ref.ID] = ref.SHA256
	}
	pin.Version = manifest.Version
	pin.SHA256 = scriptHash(string(main))
	pin.ManifestSHA256 = scriptHash(string(raw))
	return manifest, pin, nil
}
func validSkillBudget(b AuthorBudget) bool {
	return b.MaxModelRequests > 0 && b.MaxModelRequests <= 9007199254740991 && b.MaxToolCalls >= 0 && b.MaxToolCalls <= 9007199254740991 && b.MaxDurationMS > 0 && b.MaxDurationMS <= 9007199254740991
}
func validSkillModel(m AuthorModel) bool {
	return m.Provider == "opencode" && modelName.MatchString(m.Model) && (m.ReasoningEffort == "low" || m.ReasoningEffort == "medium" || m.ReasoningEffort == "high" || m.ReasoningEffort == "xhigh")
}
func configuredAuthorModel() string {
	if value, ok := os.LookupEnv("WHIPPET_AI_MODEL"); ok {
		return value
	}
	return "muse-spark-1.3-contributor"
}

// Called once at enqueue, after scope/credential policy has selected tools.
// Replays read author_payload, never rebuild this snapshot from newer packages.
func snapshotAuthor(input *AuthorInput) error {
	if input.ModuleSummary != nil && (input.SkillID != "acceptance-summary" || input.Batch != nil || input.Platform != nil) {
		return ErrInvalid
	}
	if input.Batch != nil && (input.SkillID != "acceptance-summary" || input.Platform != nil) {
		return ErrInvalid
	}
	registry, err := loadToolRegistry()
	if err != nil {
		return ErrSkillUnavailable
	}
	root := os.Getenv("WHIPPET_SKILLS_PATH")
	if root == "" {
		root = repositoryFile("runtimes", "worker", "skills")
	}
	ids := []string{input.SkillID}
	switch input.SkillID {
	case "test-author":
		ids = append(ids, "playwright-authoring")
	case "workspace-author", "acceptance-summary", "module-authoring", "usecase-planner":
	default:
		return ErrSkillUnavailable
	}
	snapshots := []SkillSnapshot{}
	defaults := map[string]bool{}
	references := 0
	var primary SkillManifest
	for i, id := range ids {
		manifest, pin, err := loadSkill(root, id, registry)
		if err != nil {
			return err
		}
		if i == 0 {
			primary = manifest
		}
		snapshots = append(snapshots, pin)
		references += len(pin.ReferenceHashes)
		for _, tool := range manifest.DefaultTools {
			defaults[tool] = true
		}
	}
	if primary.Model.Model != configuredAuthorModel() {
		return ErrSkillUnavailable
	}
	// The primary controls budgets and model; auxiliaries cannot expand Run policy.
	tools := []string{}
	seen := map[string]bool{}
	for _, tool := range input.AllowedTools {
		if defaults[tool] && !seen[tool] {
			tools = append(tools, tool)
			seen[tool] = true
		}
	}
	if references > 0 && defaults["read_skill_reference"] && !seen["read_skill_reference"] {
		tools = append(tools, "read_skill_reference")
	}
	sort.Strings(tools)
	budget := primary.Budget
	if budget.MaxDurationMS > authorTimeoutMS {
		budget.MaxDurationMS = authorTimeoutMS
	}
	input.SkillVersion = primary.Version
	input.Skills = snapshots
	input.AllowedTools = tools
	input.Budget = &budget
	input.Model = &primary.Model
	input.ToolRegistryVersion = registry.Version
	input.ToolRegistrySHA256 = registry.SHA256
	return nil
}

func requiredJSONFields(raw []byte, keys ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != len(keys) {
		return false
	}
	for _, key := range keys {
		value, ok := fields[key]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return true
}
