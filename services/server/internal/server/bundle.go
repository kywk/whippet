package server

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

type RunFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Origin  string `json:"origin"`
}
type RunBundle struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Files         []RunFile           `json:"files"`
	Stages        []Stage             `json:"stages"`
	Module        *Module             `json:"module"`
	Dependencies  []VersionDependency `json:"dependencies"`
}
type bundleMetadata struct {
	Stages       []Stage             `json:"stages"`
	Module       *Module             `json:"module"`
	Dependencies []VersionDependency `json:"dependencies"`
}

func fileOrigin(origin string) string {
	if origin == "manual" {
		return "manual"
	}
	return "ai"
}
func (b *RunBundle) canonicalize() error {
	if b.SchemaVersion != 1 || len(b.Files) < 1 || len(b.Files) > 64 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	size, entry := 0, 0
	for _, file := range b.Files {
		valid := file.Path == "tests/test.spec.ts"
		if valid {
			entry++
		} else if strings.HasPrefix(file.Path, "lib/") && strings.HasSuffix(file.Path, ".ts") {
			valid = moduleSlug.MatchString(strings.TrimSuffix(strings.TrimPrefix(file.Path, "lib/"), ".ts"))
		}
		if !valid || seen[file.Path] || len(file.Content) > MaxScriptBytes || !utf8.ValidString(file.Content) || strings.ContainsRune(file.Content, 0) || (file.Origin != "manual" && file.Origin != "ai") {
			return ErrInvalid
		}
		seen[file.Path] = true
		size += len(file.Content)
	}
	if entry != 1 || size > 8<<20 {
		return ErrInvalid
	}
	if b.Stages == nil {
		b.Stages = []Stage{}
	}
	if b.Dependencies == nil {
		b.Dependencies = []VersionDependency{}
	}
	if err := validateStages(b.Stages); err != nil {
		return err
	}
	for i := range b.Stages {
		if b.Stages[i].Kind == "module" && b.Stages[i].Args == nil {
			b.Stages[i].Args = map[string]StageArgument{}
		}
	}
	byTest := map[string]string{}
	versions := map[string]bool{}
	for _, dep := range b.Dependencies {
		if !ValidID(dep.ModuleTestID) || !ValidID(dep.ModuleVersionID) || versions[dep.ModuleVersionID] || byTest[dep.ModuleTestID] != "" {
			return ErrInvalid
		}
		versions[dep.ModuleVersionID] = true
		byTest[dep.ModuleTestID] = dep.ModuleVersionID
	}
	if b.Module != nil {
		if err := validateModule(b.Module, b.Module.Slug); err != nil {
			return err
		}
		if len(b.Stages) != 0 || len(b.Dependencies) != 0 || len(b.Files) != 2 || !seen["lib/"+b.Module.Slug+".ts"] || b.entry() != b.Module.Harness {
			return ErrInvalid
		}
	}
	sort.Slice(b.Files, func(i, j int) bool { return b.Files[i].Path < b.Files[j].Path })
	sort.Slice(b.Dependencies, func(i, j int) bool { return b.Dependencies[i].ModuleVersionID < b.Dependencies[j].ModuleVersionID })
	return nil
}
func (b RunBundle) hash() (string, error) {
	if err := b.canonicalize(); err != nil {
		return "", err
	}
	data, err := json.Marshal(b)
	if err != nil {
		return "", ErrInvalid
	}
	return scriptHash(string(data)), nil
}
func (b RunBundle) entry() string {
	for _, file := range b.Files {
		if file.Path == "tests/test.spec.ts" {
			return file.Content
		}
	}
	return ""
}
func (b RunBundle) origin() string {
	for _, file := range b.Files {
		if file.Origin != "manual" {
			return "ai"
		}
	}
	return "manual"
}
func (b RunBundle) metadata() string {
	return jsonText(bundleMetadata{b.Stages, b.Module, b.Dependencies})
}

// Runs snapshot content here; assignment/replay never resolves module versions.
func bundleForDraft(ctx context.Context, q queryDB, d draftState) (*RunBundle, error) {
	var kind, workspace string
	var slug *string
	if err := q.QueryRowContext(ctx, `SELECT kind,workspace_id,slug FROM tests WHERE id=$1`, d.TestID).Scan(&kind, &workspace, &slug); err != nil {
		return nil, dbError(err)
	}
	if kind == "test" {
		return nil, nil
	}
	bundle := &RunBundle{SchemaVersion: 1, Stages: d.Stages, Module: d.Module, Files: []RunFile{}, Dependencies: []VersionDependency{}}
	origin := fileOrigin(d.ScriptOrigin)
	switch kind {
	case "module":
		if err := validateModule(d.Module, stringValue(slug)); err != nil {
			return nil, err
		}
		bundle.Files = []RunFile{{Path: "tests/test.spec.ts", Content: d.Module.Harness, Origin: origin}, {Path: "lib/" + d.Module.Slug + ".ts", Content: d.Script, Origin: origin}}
	case "usecase":
		if d.Module != nil {
			return nil, ErrInvalid
		}
		var plan string
		// Only the owning editing session may resolve its private candidates.
		if err := q.QueryRowContext(ctx, `SELECT COALESCE((SELECT id::text FROM plans WHERE editing_session_id=$1 AND status IN ('running','composed')),'')`, d.EditingSessionID).Scan(&plan); err != nil {
			return nil, err
		}
		deps, err := resolveModuleDependencies(ctx, q, workspace, d.Stages, plan)
		if err != nil {
			return nil, err
		}
		bundle.Dependencies = deps
		bundle.Files = append(bundle.Files, RunFile{Path: "tests/test.spec.ts", Content: d.Script, Origin: origin})
		for _, dep := range deps {
			pinned, err := readPinnedModule(ctx, q, workspace, dep.ModuleTestID, dep.ModuleVersionID, plan)
			if err != nil {
				return nil, err
			}
			bundle.Files = append(bundle.Files, RunFile{Path: "lib/" + pinned.Module.Slug + ".ts", Content: pinned.Script, Origin: fileOrigin(pinned.Origin)})
		}
	default:
		return nil, ErrInvalid
	}
	if err := bundle.canonicalize(); err != nil {
		return nil, err
	}
	return bundle, nil
}

func decodeRunBundle(files, metadata []byte, hash *string, script, origin string) (*RunBundle, error) {
	if len(files) == 0 && len(metadata) == 0 && hash == nil {
		return nil, nil
	}
	if len(files) == 0 || len(metadata) == 0 || hash == nil {
		return nil, ErrConflict
	}
	var b RunBundle
	var meta bundleMetadata
	if json.Unmarshal(files, &b.Files) != nil || json.Unmarshal(metadata, &meta) != nil {
		return nil, ErrConflict
	}
	b.SchemaVersion = 1
	b.Stages = meta.Stages
	b.Module = meta.Module
	b.Dependencies = meta.Dependencies
	actual, err := b.hash()
	if err != nil || actual != *hash || b.entry() != script || b.origin() != origin {
		return nil, fmt.Errorf("%w: invalid immutable run bundle", ErrConflict)
	}
	return &b, nil
}
