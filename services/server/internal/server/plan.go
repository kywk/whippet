package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

type PlannedModule struct {
	Slug        string `json:"slug"`
	ModuleKind  string `json:"moduleKind"`
	Description string `json:"description"`
}
type PlanStageInput struct {
	ID              string                   `json:"id"`
	Title           string                   `json:"title"`
	Action          string                   `json:"action"`
	ModuleTestID    string                   `json:"moduleTestId,omitempty"`
	ModuleVersionID string                   `json:"moduleVersionId,omitempty"`
	Module          *PlannedModule           `json:"module,omitempty"`
	Args            map[string]StageArgument `json:"args"`
	Bind            string                   `json:"bind,omitempty"`
}
type PlanStage struct {
	PlanStageInput
	Status             string  `json:"status"`
	DraftRevision      *int    `json:"draftRevision,omitempty"`
	CandidateVersionID *string `json:"candidateVersionId,omitempty"`
	AuthorRunID        *string `json:"authorRunId,omitempty"`
	ValidationRunID    *string `json:"validationRunId,omitempty"`
	Error              *string `json:"error,omitempty"`
}
type Plan struct {
	ID               string      `json:"id"`
	TestID           string      `json:"testId"`
	EditingSessionID string      `json:"editingSessionId"`
	Revision         int         `json:"revision"`
	BaseRevision     int         `json:"baseRevision"`
	ContextRevision  int64       `json:"contextRevision"`
	Status           string      `json:"status"`
	Stages           []PlanStage `json:"stages"`
	ValidationRunID  *string     `json:"validationRunId,omitempty"`
	Error            *string     `json:"error,omitempty"`
}

const planColumns = `id,test_id,editing_session_id,revision,base_revision,context_revision,status,stages,validation_run_id,error`

func scanPlan(row scanner) (*Plan, error) {
	var p Plan
	var raw []byte
	err := row.Scan(&p.ID, &p.TestID, &p.EditingSessionID, &p.Revision, &p.BaseRevision, &p.ContextRevision, &p.Status, &raw, &p.ValidationRunID, &p.Error)
	if err == nil {
		err = json.Unmarshal(raw, &p.Stages)
	}
	if err != nil {
		return nil, dbError(err)
	}
	return &p, nil
}
func requireUseCase(ctx context.Context, q queryDB, test string) error {
	var kind string
	if err := q.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, test).Scan(&kind); err != nil {
		return dbError(err)
	}
	if kind != "usecase" {
		return ErrConflict
	}
	return nil
}
func preparePlanStages(ctx context.Context, q queryDB, workspace string, inputs []PlanStageInput) ([]PlanStage, error) {
	registry, err := loadToolRegistry()
	if err != nil {
		return nil, err
	}
	tool, ok := registry.tool("propose_plan")
	if !ok {
		return nil, ErrInvalid
	}
	raw, err := json.Marshal(map[string]any{"stages": inputs})
	if err != nil {
		return nil, ErrInvalid
	}
	if _, err = validateToolArguments(tool, raw); err != nil {
		return nil, err
	}
	if len(inputs) < 1 || len(inputs) > 32 {
		return nil, ErrInvalid
	}
	stages := []PlanStage{}
	seen := map[string]bool{}
	for _, input := range inputs {
		if input.ID == "" || len(input.ID) > 64 || !validOutputText(input.Title, 1024) || seen[input.ID] || input.Args == nil {
			return nil, ErrInvalid
		}
		seen[input.ID] = true
		switch input.Action {
		case "reuse", "modify":
			if !ValidID(input.ModuleVersionID) || input.Module != nil {
				return nil, ErrInvalid
			}
			var testID string
			if err := q.QueryRowContext(ctx, `SELECT t.id FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.id=$1 AND t.workspace_id=$2 AND t.kind='module' AND v.module IS NOT NULL`, input.ModuleVersionID, workspace).Scan(&testID); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return nil, ErrInvalid
				}
				return nil, err
			}
			if input.ModuleTestID != "" && input.ModuleTestID != testID {
				return nil, ErrInvalid
			}
			input.ModuleTestID = testID
		case "create":
			if input.ModuleVersionID != "" || input.ModuleTestID != "" || input.Module == nil || !moduleSlug.MatchString(input.Module.Slug) || len(input.Module.Description) > 16384 {
				return nil, ErrInvalid
			}
			if input.Module.ModuleKind != "setup" && input.Module.ModuleKind != "step" && input.Module.ModuleKind != "page" {
				return nil, ErrInvalid
			}
		default:
			return nil, ErrInvalid
		}
		stages = append(stages, PlanStage{PlanStageInput: input, Status: "pending"})
	}
	// Validate all bindings without assigning persistent candidate/version IDs.
	shapes := []Stage{}
	identities := map[string]string{}
	for _, s := range stages {
		test, version := s.ModuleTestID, s.ModuleVersionID
		if s.Action == "create" {
			test = NewID()
			version = NewID()
		}
		if s.Action == "modify" {
			version = identities[test]
			if version == "" {
				version = NewID()
				identities[test] = version
			}
		}
		shapes = append(shapes, Stage{ID: s.ID, Title: s.Title, Kind: "module", ModuleTestID: test, ModuleVersionID: version, Args: s.Args, Bind: s.Bind})
	}
	if err := validateStages(shapes); err != nil {
		return nil, err
	}
	return stages, nil
}
func (p *Postgres) Plan(ctx context.Context, test, session string) (*Plan, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, _, err = requireEditingDraft(ctx, tx, test, session); err != nil {
		return nil, err
	}
	if err = requireUseCase(ctx, tx, test); err != nil {
		return nil, err
	}
	if err = refreshPlanOutcomes(ctx, tx, test); err != nil {
		return nil, err
	}
	plan, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE test_id=$1 AND editing_session_id=$2`, test, session))
	if errors.Is(err, ErrNotFound) {
		return nil, tx.Commit()
	}
	if err != nil {
		return nil, err
	}
	return plan, tx.Commit()
}
func (p *Postgres) SavePlan(ctx context.Context, test, session string, revision, planRevision int, inputs []PlanStageInput) (*Plan, error) {
	if revision < 1 || planRevision < 0 {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	d, s, err := requireEditingDraft(ctx, tx, test, session)
	if err != nil {
		return nil, err
	}
	if err = requireUseCase(ctx, tx, test); err != nil {
		return nil, err
	}
	if err = checkRevision(revision, d.Revision); err != nil {
		return nil, err
	}
	if err = refreshPlanOutcomes(ctx, tx, test); err != nil {
		return nil, err
	}
	current, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE editing_session_id=$1 FOR UPDATE`, session))
	id := NewID()
	if errors.Is(err, ErrNotFound) {
		if planRevision != 0 {
			return nil, ErrConflict
		}
	} else if err != nil {
		return nil, err
	} else {
		if current.Revision != planRevision || (current.Status != "draft" && current.Status != "stopped") {
			return nil, ErrConflict
		}
		id = current.ID
	}
	stages, err := preparePlanStages(ctx, tx, s.WorkspaceID, inputs)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET context_revision=context_revision+1 WHERE id=$1`, session); err != nil {
		return nil, err
	}
	plan, err := scanPlan(tx.QueryRowContext(ctx, `INSERT INTO plans(id,test_id,editing_session_id,revision,base_revision,context_revision,status,stages) VALUES($1,$2,$3,$4,$5,$6,'draft',$7)
 ON CONFLICT(editing_session_id) DO UPDATE SET revision=EXCLUDED.revision,base_revision=EXCLUDED.base_revision,context_revision=EXCLUDED.context_revision,status='draft',stages=EXCLUDED.stages,validation_run_id=NULL,error=NULL RETURNING `+planColumns, id, test, session, planRevision+1, d.Revision, s.ContextRevision+1, jsonText(stages)))
	if err != nil {
		return nil, err
	}
	if err = clearDraftSummary(ctx, tx, test); err != nil {
		return nil, err
	}
	return plan, tx.Commit()
}

// Stable identifier-free templates: only JSON literals or generated local names
// enter code. Computed object keys avoid __proto__ object-literal semantics.
func composeUseCase(ctx context.Context, q queryDB, workspace string, stages []PlanStage, planIDs ...string) (string, []Stage, error) {
	shape := []Stage{}
	for _, s := range stages {
		if s.Action != "reuse" {
			if s.Status != "ready" || s.CandidateVersionID == nil {
				return "", nil, ErrConflict
			}
			s.ModuleVersionID = *s.CandidateVersionID
		}
		shape = append(shape, Stage{ID: s.ID, Title: s.Title, Kind: "module", ModuleTestID: s.ModuleTestID, ModuleVersionID: s.ModuleVersionID, Args: s.Args, Bind: s.Bind})
	}
	deps, err := resolveModuleDependencies(ctx, q, workspace, shape, planIDs...)
	if err != nil {
		return "", nil, err
	}
	var code strings.Builder
	code.WriteString("import { test } from '@playwright/test';\n")
	aliases := map[string]string{}
	for i, dep := range deps {
		plan := ""
		if len(planIDs) > 0 {
			plan = planIDs[0]
		}
		pinned, err := readPinnedModule(ctx, q, workspace, dep.ModuleTestID, dep.ModuleVersionID, plan)
		if err != nil {
			return "", nil, err
		}
		m := pinned.Module
		alias := fmt.Sprintf("_module%d", i)
		aliases[dep.ModuleVersionID] = alias
		fmt.Fprintf(&code, "import { %s as %s } from %s;\n", m.ExportName, alias, jsonText("@lib/"+m.Slug))
	}
	code.WriteString("test('Use Case', async ({page}) => {\n")
	results := map[string]string{}
	for i, s := range shape {
		args := []string{}
		keys := []string{}
		for key := range s.Args {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			arg := s.Args[key]
			expression := ""
			if arg.Kind == "literal" {
				var literal any
				if json.Unmarshal(arg.Value, &literal) != nil {
					return "", nil, ErrInvalid
				}
				expression = "JSON.parse(" + jsonText(jsonText(literal)) + ")"
			} else {
				expression = results[arg.StageID]
				if expression == "" {
					return "", nil, ErrInvalid
				}
				for _, part := range arg.Path {
					expression += "[" + jsonText(part) + "]"
				}
			}
			args = append(args, "["+jsonText(key)+"]: "+expression)
		}
		local := fmt.Sprintf("_stage%d", i)
		results[s.ID] = local
		fmt.Fprintf(&code, "const %s = await test.step(%s, async () => %s({page, ...{%s}}));\n", local, jsonText(s.Title), aliases[s.ModuleVersionID], strings.Join(args, ", "))
	}
	code.WriteString("});\n")
	if code.Len() > MaxScriptBytes {
		return "", nil, ErrInvalid
	}
	return code.String(), shape, nil
}
