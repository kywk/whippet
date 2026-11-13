package server

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Module struct {
	Slug           string `json:"slug"`
	ModuleKind     string `json:"moduleKind"`
	ExportName     string `json:"exportName"`
	Signature      string `json:"signature"`
	Inputs         string `json:"inputs"`
	Returns        string `json:"returns"`
	Preconditions  string `json:"preconditions"`
	Postconditions string `json:"postconditions"`
	Harness        string `json:"harness"`
}

type StageArgument struct {
	Kind    string          `json:"kind"`
	Value   json.RawMessage `json:"value,omitempty"`
	StageID string          `json:"stageId,omitempty"`
	Path    []string        `json:"path,omitempty"`
}
type Stage struct {
	ID              string                   `json:"id"`
	Title           string                   `json:"title"`
	Kind            string                   `json:"kind"`
	ModuleTestID    string                   `json:"moduleTestId,omitempty"`
	ModuleVersionID string                   `json:"moduleVersionId,omitempty"`
	Args            map[string]StageArgument `json:"args,omitempty"`
	Bind            string                   `json:"bind,omitempty"`
	Script          string                   `json:"script,omitempty"`
}
type VersionDependency struct {
	ModuleTestID    string `json:"moduleTestId"`
	ModuleVersionID string `json:"moduleVersionId"`
}

var moduleSlug = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func validExportName(name string) bool {
	if name == "" || strings.Contains(" await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval ", " "+name+" ") {
		return false
	}
	for i, r := range name {
		if r == '_' || r == '$' || unicode.IsLetter(r) || (i > 0 && (unicode.IsDigit(r) || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r) || r == '\u200c' || r == '\u200d')) {
			continue
		}
		return false
	}
	return utf8.ValidString(name)
}
func validateModule(m *Module, slug string) error {
	if m == nil || m.Slug != slug || !moduleSlug.MatchString(slug) || !validExportName(m.ExportName) {
		return fmt.Errorf("%w: invalid module identity", ErrInvalid)
	}
	registry, err := loadToolRegistry()
	if err != nil {
		return ErrSkillUnavailable
	}
	tool, ok := registry.tool("update_module_candidate")
	if !ok {
		return ErrInvalid
	}
	raw, err := json.Marshal(map[string]any{"script": "", "module": m})
	if err != nil {
		return ErrInvalid
	}
	if _, err = validateToolArguments(tool, raw); err != nil {
		return err
	}
	if m.ModuleKind != "setup" && m.ModuleKind != "step" && m.ModuleKind != "page" {
		return fmt.Errorf("%w: invalid module kind", ErrInvalid)
	}
	for _, s := range []string{m.Signature, m.Inputs, m.Returns, m.Preconditions, m.Postconditions} {
		if !utf8.ValidString(s) || strings.ContainsRune(s, 0) {
			return ErrInvalid
		}
	}
	if strings.TrimSpace(m.Harness) == "" || len(m.Harness) > MaxScriptBytes || !utf8.ValidString(m.Harness) || strings.ContainsRune(m.Harness, 0) {
		return fmt.Errorf("%w: module harness required", ErrInvalid)
	}
	return nil
}
func validateStages(stages []Stage) error {
	seen := map[string]string{}
	versions := map[string]string{}
	for _, s := range stages {
		if s.ID == "" || len(s.ID) > 64 || s.Title == "" || len(s.Title) > 1024 || seen[s.ID] != "" {
			return ErrInvalid
		}
		switch s.Kind {
		case "inline":
			if strings.TrimSpace(s.Script) == "" || len(s.Script) > MaxScriptBytes || s.ModuleTestID != "" || s.ModuleVersionID != "" || len(s.Args) > 0 || s.Bind != "" {
				return ErrInvalid
			}
		case "module":
			if !ValidID(s.ModuleTestID) || !ValidID(s.ModuleVersionID) || s.Script != "" {
				return ErrInvalid
			}
			if prior := versions[s.ModuleTestID]; prior != "" && prior != s.ModuleVersionID {
				return fmt.Errorf("%w: one module version per bundle", ErrInvalid)
			}
			versions[s.ModuleTestID] = s.ModuleVersionID
			for key, arg := range s.Args {
				if key == "page" {
					return fmt.Errorf("%w: page is reserved", ErrInvalid)
				}
				switch arg.Kind {
				case "literal":
					if !json.Valid(arg.Value) || arg.StageID != "" || arg.Path != nil {
						return ErrInvalid
					}
				case "binding":
					if seen[arg.StageID] != "module" || arg.Value != nil {
						return fmt.Errorf("%w: binding must reference an earlier module stage", ErrInvalid)
					}
				default:
					return ErrInvalid
				}
			}
		default:
			return ErrInvalid
		}
		seen[s.ID] = s.Kind
	}
	return nil
}

// API keeps the original CreateTest path for older Store implementations.
func (p *Postgres) CreatePlatformTest(ctx context.Context, workspace, name, description, kind string, slug *string) (Test, error) {
	if kind == "" {
		kind = "test"
	}
	if kind == "test" && slug == nil {
		return p.CreateTest(ctx, workspace, name, description)
	}
	if (kind != "module" && kind != "usecase") || (kind == "module" && (slug == nil || !moduleSlug.MatchString(*slug))) || (kind == "usecase" && slug != nil) {
		return Test{}, ErrInvalid
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "未命名測試"
	}
	if len(name) > 200 || len(description) > 16384 {
		return Test{}, ErrInvalid
	}
	return scanTest(p.DB.QueryRowContext(ctx, `INSERT INTO tests(id,workspace_id,name,description,kind,slug) SELECT $1,id,$3,$4,$5,$6 FROM workspaces WHERE id=$2 RETURNING `+testColumns, NewID(), workspace, name, description, kind, slug))
}

func platformJSON(module *Module, stages []Stage) (string, string) {
	if stages == nil {
		stages = []Stage{}
	}
	m, _ := json.Marshal(module)
	s, _ := json.Marshal(stages)
	return string(m), string(s)
}

func (p *Postgres) SavePlatformDraft(ctx context.Context, test, session string, revision int, script string, module *Module, stages []Stage) (Draft, error) {
	if len(script) > MaxScriptBytes || !utf8.ValidString(script) || strings.ContainsRune(script, 0) {
		return Draft{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Draft{}, err
	}
	defer tx.Rollback()
	d, _, err := requireEditingDraft(ctx, tx, test, session)
	if err != nil {
		return Draft{}, err
	}
	if err = checkRevision(revision, d.Revision); err != nil {
		return Draft{}, err
	}
	var kind string
	var slug *string
	if err = tx.QueryRowContext(ctx, `SELECT kind,slug FROM tests WHERE id=$1`, test).Scan(&kind, &slug); err != nil {
		return Draft{}, err
	}
	switch kind {
	case "module":
		if len(stages) != 0 {
			return Draft{}, ErrInvalid
		}
		if err = validateModule(module, stringValue(slug)); err != nil {
			return Draft{}, err
		}
	case "usecase":
		return Draft{}, fmt.Errorf("%w: Use Case editing requires the Compose workflow", ErrConflict)
	default:
		return Draft{}, ErrInvalid
	}
	m, s := platformJSON(module, stages)
	oldM, oldS := platformJSON(d.Module, d.Stages)
	if script == d.Script && m == oldM && s == oldS {
		return d.Draft, nil
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,module,stages) VALUES($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9)`, test, d.Revision+1, script, scriptHash(script), d.timeoutMS, settingsJSON(d.WorkspaceSettings), jsonText(d.WorkspaceContext), m, s)
	if err != nil {
		return Draft{}, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE drafts SET current_revision=current_revision+1,validation_run_id=NULL,summary_run_id=NULL,summary_description=NULL,summary_background=NULL,summary_name=NULL,updated_at=now() WHERE test_id=$1`, test)
	if err != nil {
		return Draft{}, err
	}
	d, err = scanDraft(tx.QueryRowContext(ctx, draftSelect, test))
	if err != nil {
		return Draft{}, err
	}
	if err = tx.Commit(); err != nil {
		return Draft{}, err
	}
	return d.Draft, nil
}

// Resolve exact immutable versions, never tests.published_version_id. The caller
// supplies the owning Workspace from its locked Use Case, not tool arguments.
func resolveModuleDependencies(ctx context.Context, q queryDB, workspace string, stages []Stage, planIDs ...string) ([]VersionDependency, error) {
	if err := validateStages(stages); err != nil {
		return nil, err
	}
	deps := []VersionDependency{}
	seen := map[string]bool{}
	for _, s := range stages {
		if s.Kind != "module" || seen[s.ModuleVersionID] {
			continue
		}
		plan := ""
		if len(planIDs) > 0 {
			plan = planIDs[0]
		}
		if _, err := readPinnedModule(ctx, q, workspace, s.ModuleTestID, s.ModuleVersionID, plan); err != nil {
			return nil, err
		}
		seen[s.ModuleVersionID] = true
		deps = append(deps, VersionDependency{s.ModuleTestID, s.ModuleVersionID})
	}
	return deps, nil
}

// Fail closed until the bundle dispatch/validation slice is installed. Otherwise
// a Module body could accidentally be validated/published as a standalone spec.
func requireSingleScriptTest(ctx context.Context, q queryDB, test string) error {
	var kind string
	if err := q.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, test).Scan(&kind); err != nil {
		return dbError(err)
	}
	if kind != "test" {
		return fmt.Errorf("%w: bundle execution is not enabled yet", ErrConflict)
	}
	return nil
}

func stagesJSON(stages []Stage) string { _, s := platformJSON(nil, stages); return s }

// Preserve the tagged wire shape, including an empty binding path (whole value).
func (a StageArgument) MarshalJSON() ([]byte, error) {
	if a.Kind == "binding" {
		path := a.Path
		if path == nil {
			path = []string{}
		}
		return json.Marshal(struct {
			Kind    string   `json:"kind"`
			StageID string   `json:"stageId"`
			Path    []string `json:"path"`
		}{a.Kind, a.StageID, path})
	}
	var value any
	if err := json.Unmarshal(a.Value, &value); err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		Kind  string `json:"kind"`
		Value any    `json:"value"`
	}{a.Kind, value})
}
