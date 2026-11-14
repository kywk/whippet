package manager

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxWorkerInputBytes = 64 << 20

var bundleModulePath = regexp.MustCompile(`^lib/[a-z][a-z0-9-]{0,63}\.ts$`)
var errBundle = errors.New("invalid run bundle")

type RunFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Origin  string `json:"origin"`
}

type ModuleABI struct {
	Slug       string `json:"slug"`
	ExportName string `json:"exportName"`
}

func validModuleABIName(name string) bool {
	if name == "" || strings.Contains(" await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments ", " "+name+" ") {
		return false
	}
	for i, r := range name {
		if r == '_' || r == '$' || unicode.IsLetter(r) || i > 0 && (unicode.IsDigit(r) || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r) || r == '\u200c' || r == '\u200d') {
			continue
		}
		return false
	}
	return utf8.ValidString(name)
}

func (f *RunFile) UnmarshalJSON(raw []byte) error {
	type fields RunFile
	if !utf8.Valid(raw) || !exactWorkspaceObject(raw, "path", "content", "origin") {
		return errBundle
	}
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil {
		return errBundle
	}
	for _, value := range values {
		if string(value) == "null" {
			return errBundle
		}
	}
	return json.Unmarshal(raw, (*fields)(f))
}
func normalizeBundle(d *Dispatch) error {
	if d.Files == nil {
		if d.ModuleABI != nil {
			return errBundle
		}
		return nil
	}
	if !validScriptOrigin(d.ScriptOrigin) || d.Kind != "run" || d.Author != nil || len(d.Files) < 1 || len(d.Files) > 64 {
		return errBundle
	}
	paths := map[string]bool{}
	total := 0
	entry := ""
	origin := "manual"
	for _, file := range d.Files {
		if file.Path != "tests/test.spec.ts" && !bundleModulePath.MatchString(file.Path) || paths[file.Path] ||
			!utf8.ValidString(file.Content) || strings.ContainsRune(file.Content, 0) || len(file.Content) > maxScriptBytes || file.Origin != "manual" && file.Origin != "ai" {
			return errBundle
		}
		total += len(file.Content)
		if total > 8<<20 {
			return errBundle
		}
		paths[file.Path] = true
		if file.Path == "tests/test.spec.ts" {
			entry = file.Content
		}
		if file.Origin != "manual" {
			origin = "ai"
		}
	}
	if strings.TrimSpace(entry) == "" || d.Script != "" && d.Script != entry {
		return errBundle
	}
	if d.ModuleABI != nil && (len(d.Files) != 2 || !bundleModulePath.MatchString("lib/"+d.ModuleABI.Slug+".ts") || !paths["lib/"+d.ModuleABI.Slug+".ts"] || !validModuleABIName(d.ModuleABI.ExportName)) {
		return errBundle
	}
	d.Script = entry
	d.ScriptOrigin = origin
	return nil
}
