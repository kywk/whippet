//go:build integration && m12module && m12livecase

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// All outputs belong to a new explicitly selected directory and random schema.
// Longer orchestration time permits several Runs, not a larger per-Run policy.
func TestM12RepresentativeUseCaseFlow(t *testing.T) {
	mode, out, image := os.Getenv("WHIPPET_M12_USECASE_MODE"), os.Getenv("WHIPPET_M12_USECASE_OUT"), os.Getenv("WHIPPET_M12_USECASE_IMAGE")
	if mode != "live" && mode != "synthetic" || out == "" || !strings.HasPrefix(image, "sha256:") {
		t.Fatal("explicit isolated harness configuration required")
	}
	full := os.Getenv("WHIPPET_M12_USECASE_FULL") == "1"
	reviewed := os.Getenv("WHIPPET_M12_USECASE_REVIEWED_PLAN") == "1"
	if reviewed && !full {
		t.Fatal("reviewed plan requires full scope")
	}
	wave := "14"
	if full {
		wave = "15"
	}
	newModules := 1
	if full {
		newModules = 2
	}
	m10SkillRoot(t)
	cleanRuntimeEnv(t)
	p, _ := workspaceTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	w, err := p.CreateWorkspace(ctx, "M12 owned representative")
	if err != nil {
		t.Fatal(err)
	}
	item, err := p.CreatePlatformTest(ctx, w.ID, "M12 local outcome", "", "usecase", nil)
	if err != nil {
		t.Fatal(err)
	}
	config, err := normalizeConfig(WorkspaceConfig{Name: "M12 representative", Purpose: "owned offline DOM fixture", BackgroundSummary: "Published setup returns {name:alpha}; all page content is local synthetic fixture", TimeoutMS: 60000, Targets: []WorkspaceOrigin{{Name: "fixture", Purpose: "test", Origin: "https://example.test"}}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',canonical_config=$2,authorization_revision=1 WHERE id=$1`, item.WorkspaceID, jsonText(config)); err != nil {
		t.Fatal(err)
	}
	editing, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	var revision int
	if err = p.DB.QueryRowContext(ctx, `SELECT (settings->>'revision')::integer FROM workspaces WHERE id=$1`, item.WorkspaceID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if _, err = p.SetAgentRuntime(ctx, item.WorkspaceID, revision, RuntimeSelection{ProfileID: "vercel", SkillProfiles: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(filepath.Join(out, "artifacts"))
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	if err = p.RegisterManager(ctx, "m12-representative", 1); err != nil {
		t.Fatal(err)
	}
	var a *Assignment
	receipts := []any{}
	save := func(name string, v any) {
		t.Helper()
		f, e := os.OpenFile(filepath.Join(out, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		if _, e = f.WriteString(jsonText(v) + "\n"); e != nil {
			t.Fatal(e)
		}
	}
	claim := func(kind string) *Assignment {
		t.Helper()
		v, e := p.Claim(ctx, "m12-representative", 1)
		if e != nil || v == nil || v.Kind != kind {
			t.Fatal("claim", kind, e)
		}
		return v
	}
	fixture := func() moduleCheckpointFixture { return moduleCheckpointFixture{p: p, ctx: ctx, a: a, files: files} }
	worker := func(label string, scripted []any) Run {
		t.Helper()
		replay := os.Getenv("WHIPPET_M12_USECASE_REPLAY")
		replayed := replay != "" && (label == "module" || label == "module-confirm")
		if replayed {
			raw, e := os.ReadFile(filepath.Join(replay, label+".json"))
			if e != nil {
				t.Fatal(e)
			}
			oldInputRaw, e := os.ReadFile(filepath.Join(replay, label+"-assignment.json"))
			if e != nil {
				t.Fatal(e)
			}
			var source struct {
				Status    string             `json:"status"`
				Synthetic bool               `json:"synthetic"`
				Artifact  moduleAuthorOutput `json:"artifact"`
			}
			var oldInput struct {
				Author AuthorInput `json:"author"`
			}
			if json.Unmarshal(raw, &source) != nil || json.Unmarshal(oldInputRaw, &oldInput) != nil || source.Status != "PASS" || source.Synthetic || source.Artifact.Script == nil || source.Artifact.Module == nil || source.Artifact.Partial != nil || source.Artifact.Module.Slug != a.Author.Platform.Module.Slug || oldInput.Author.ToolRegistrySHA256 != a.Author.ToolRegistrySHA256 || jsonText(oldInput.Author.Skills) != jsonText(a.Author.Skills) || jsonText(oldInput.Author.Model) != jsonText(a.Author.Model) || jsonText(oldInput.Author.Runtime) != jsonText(a.Author.Runtime) {
				t.Fatal("replay provenance drift")
			}
			m := source.Artifact.Module
			metadata := map[string]any{"slug": m.Slug, "moduleKind": m.ModuleKind, "exportName": m.ExportName, "signature": m.Signature, "inputs": m.Inputs, "returns": m.Returns, "preconditions": m.Preconditions, "postconditions": m.Postconditions}
			scripted = []any{map[string]any{"name": "stage_module_candidate_part", "arguments": map[string]any{"part": "script", "stagingRevision": 0, "content": *source.Artifact.Script}}, map[string]any{"name": "stage_module_candidate_part", "arguments": map[string]any{"part": "harness", "stagingRevision": 1, "content": m.Harness}}, map[string]any{"name": "commit_module_candidate", "arguments": map[string]any{"stagingRevision": 2, "metadata": metadata}}}
			save(label+"-replay-source.json", map[string]any{"source": filepath.Join(replay, label+".json"), "receiptSha256": scriptHash(string(raw)), "assignmentSha256": scriptHash(string(oldInputRaw)), "scriptSha256": scriptHash(*source.Artifact.Script), "harnessSha256": scriptHash(m.Harness), "samePinsAndRuntime": true})
		}
		taskMode := mode
		if label == "seed-summary" || replayed {
			taskMode = "synthetic"
		}
		t.Log("starting", label, taskMode)
		if a.Author.Runtime == nil || a.Author.Runtime.Engine != "vercel" {
			t.Fatal("runtime not pinned to production Vercel")
		}
		registry, e := loadToolRegistry()
		if e != nil {
			t.Fatal(e)
		}
		token := NewID()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != "POST" || r.Header.Get("X-M12-Test-Token") != token {
				w.WriteHeader(403)
				return
			}
			raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, maxHarnessFrameBytes))
			if e != nil {
				w.WriteHeader(400)
				return
			}
			request, _, e := decodeHarnessRequest(raw, registry)
			if e != nil {
				w.WriteHeader(400)
				return
			}
			requestFile := filepath.Join(out, label+"-tool-"+request.CallID+".json")
			receipt, recordErr := os.OpenFile(requestFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if recordErr == nil {
				_, recordErr = receipt.WriteString(jsonText(request) + "\n")
				receipt.Close()
			}
			if recordErr != nil {
				w.WriteHeader(500)
				return
			}
			value, e := p.HarnessPlatform(r.Context(), a.ManagerID, a.ID, a.AttemptID, request, registry, func() bool { return true })
			if e != nil {
				w.WriteHeader(409)
				return
			}
			_ = json.NewEncoder(w).Encode(value)
		}))
		defer server.Close()
		input := map[string]any{"kind": "author", "runId": a.ID, "attemptId": a.AttemptID, "script": a.Script, "timeoutMs": a.TimeoutMS, "workspaceId": a.WorkspaceID, "testId": a.TestID, "workspaceContext": a.WorkspaceContext, "workspaceSettings": a.WorkspaceSettings, "scriptOrigin": a.ScriptOrigin, "author": a.Author}
		cmd := exec.CommandContext(ctx, "node", repositoryFile("scripts", "test", "m12-usecase-worker.mjs"))
		for _, k := range []string{"PATH", "HOME", "TMPDIR", "LANG", "WHIPPET_AI_ENABLED", "WHIPPET_AI_BASE_URL", "WHIPPET_AI_MODEL", "WHIPPET_AI_REASONING_EFFORT", "OPENCODE_API_KEY"} {
			if v := os.Getenv(k); v != "" {
				cmd.Env = append(cmd.Env, k+"="+v)
			}
		}
		save(label+"-assignment.json", input)
		cmd.Stdin = strings.NewReader(jsonText(map[string]any{"input": input, "image": image, "harnessURL": server.URL, "harnessToken": token, "synthetic": mode == "synthetic" || label == "seed-summary" || replayed, "wave": wave, "scriptedCalls": scripted}))
		cmd.Stderr = os.Stderr
		raw, e := cmd.Output()
		var result struct {
			Status   string          `json:"status"`
			Code     string          `json:"code"`
			Artifact json.RawMessage `json:"artifact"`
		}
		if json.Unmarshal(raw, &result) != nil {
			t.Fatal("invalid bounded worker receipt")
		}
		save(label+".json", json.RawMessage(raw))
		receipts = append(receipts, map[string]any{"role": label, "runId": a.ID, "status": result.Status, "synthetic": mode == "synthetic" || label == "seed-summary" || replayed, "replayed": replayed})
		if e != nil || result.Status != "PASS" {
			t.Fatal("worker stopped; no model retry", label, result.Code)
		}
		fixture().manager(t, result.Artifact)
		done := fixture().finish(t, result.Artifact, "succeeded")
		if done.Status != "succeeded" || done.AuthorPartial != nil {
			t.Fatal("incomplete author", label, done.Status)
		}
		if e = p.ReleaseSlots(ctx, a.ManagerID, nil); e != nil {
			t.Fatal(e)
		}
		t.Log("completed", label)
		return done
	}
	runBrowser := func(label string, wire map[string]any) (string, Result) {
		t.Helper()
		directory := filepath.Join(out, label)
		if e := os.Mkdir(directory, 0700); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(directory, "input.json"), []byte(jsonText(wire)), 0600); e != nil {
			t.Fatal(e)
		}
		name := "whippet-m12-w" + wave + "-" + NewID()
		cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "--name", name, "--label", "whippet.test=m12-wave"+wave, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1g", "--cpus", "1", "--tmpfs", "/tmp:rw,size=512m", "--mount", "type=bind,src="+directory+",dst=/work", image)
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard
		e := cmd.Run()
		cleanup := exec.Command("docker", "rm", "-f", name)
		_ = cleanup.Run()
		raw, readErr := os.ReadFile(filepath.Join(directory, "output", "result.json"))
		var result Result
		if readErr != nil || json.Unmarshal(raw, &result) != nil {
			t.Fatal("browser report unavailable", label)
		}
		if e != nil || result.Status != "succeeded" {
			t.Fatal("browser assertion failed", label, result.Status)
		}
		return directory, result
	}
	validate := func(label string) {
		t.Helper()
		wire := map[string]any{"runId": a.ID, "attemptId": a.AttemptID, "script": a.Script, "files": a.Files, "timeoutMs": a.TimeoutMS, "workspaceId": a.WorkspaceID, "testId": a.TestID, "workspaceContext": a.WorkspaceContext, "workspaceSettings": a.WorkspaceSettings, "scriptOrigin": a.ScriptOrigin}
		if a.ModuleABI != nil {
			wire["moduleAbi"] = a.ModuleABI
		}
		directory, result := runBrowser(label, wire)
		for _, name := range []string{"results.json", "report.html"} {
			file, e := os.Open(filepath.Join(directory, "output", name))
			if e != nil {
				t.Fatal(e)
			}
			artifact, e := files.Save(a.ID, a.AttemptID, name, file)
			file.Close()
			if e != nil {
				t.Fatal(e)
			}
			if e = p.SaveArtifact(ctx, artifact); e != nil {
				t.Fatal(e)
			}
		}
		if e := p.Complete(ctx, a.ManagerID, a.ID, a.AttemptID, result); e != nil {
			t.Fatal(e)
		}
		if e := p.ReleaseSlots(ctx, a.ManagerID, nil); e != nil {
			t.Fatal(e)
		}
	}
	// Build the reusable fixture through actual validation/publication. A plain
	// fixture version without formal evidence cannot enter a verified batch.
	slug := "setup"
	seedTest, err := p.CreatePlatformTest(ctx, item.WorkspaceID, "Verified setup", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	seedEditing, _, err := p.StartEditingSession(ctx, seedTest.ID)
	if err != nil {
		t.Fatal(err)
	}
	seedMeta := &Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare", Signature: "prepare({page})", Inputs: "page", Returns: "{name:alpha}", Preconditions: "fresh page", Postconditions: "h1 alpha", Harness: m10BundleSpec}
	seedDraft, err := p.SavePlatformDraft(ctx, seedTest.ID, seedEditing.ID, seedEditing.Draft.Revision, m10BundleModule, seedMeta, nil)
	if err != nil {
		t.Fatal(err)
	}
	seedValidation, err := p.ValidateDraft(ctx, seedTest.ID, seedEditing.ID, seedDraft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a = claim("validation")
	validate("seed-validation")
	seedSummary, err := p.CreateSummary(ctx, seedTest.ID, seedEditing.ID, seedDraft.Revision, seedValidation.ID)
	if err != nil {
		t.Fatal(err)
	}
	a = claim("author")
	worker("seed-summary", []any{map[string]any{"final": map[string]any{"message": "fixture summary", "description": "已以真Playwright驗證合成setup", "backgroundSummary": "僅為本波可重複的受控fixture，不是業務實測", "name": "Verified setup"}}})
	seedVersion, err := p.Publish(ctx, seedTest.ID, seedEditing.ID, seedDraft.Revision, seedSummary.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	save("seed-publication.json", seedVersion)
	seed := PlanStageInput{ID: "prepare", Title: "Reuse verified setup", Action: "reuse", ModuleVersionID: seedVersion.ID, Args: map[string]StageArgument{}}
	prompt := "請提出兩階段Use Case Plan，先Catalog查找並複用已發佈setup（export prepare，回傳{name:'alpha'}），綁定name給新Module m12-verify。新Module固定export run({page,name})，在page.setContent建立本機按鈕Continue alpha；點擊後role=status顯示done-alpha，必須以Playwright expect核對實際頁面結果，回傳{name,status}。獨立harness需在新頁傳name=alpha，核對回傳與頁面狀態；不能匯入其他Module或導航、fetch、讀檔。metadata寫明前後條件。只保存兩段draft Plan，不自行確認或發佈。已發佈固定版本資料：" + seed.ModuleVersionID
	if full {
		prompt = strings.ReplaceAll(strings.ReplaceAll(prompt, "兩階段", "三階段"), "只保存兩段draft Plan", "只保存三段draft Plan")
		prompt += "\n此為M12.Z三階段流程：在上述複用setup及新m12-verify之後，必須再新建第二個Module m12-confirm，export run({page,name,status})。name和status都由m12-verify的回傳綁定。m12-confirm只讀取既有頁面，必須expect核對傳入status為done-alpha且與真role=status相符，name為alpha；不能重建、導航或修改頁面。回傳{name,status,confirmed:true}。其獨立harness需先setContent建立既有role=status=done-alpha頁面，再傳name=alpha/status=done-alpha核對回傳與原頁面未變。兩個新Module不能互相import。只保存三段draft Plan。"
	}
	next := PlanStageInput{ID: "verify", Title: "Verify actual local button result", Action: "create", Module: &PlannedModule{Slug: "m12-verify", ModuleKind: "step", Description: "export run({page,name}); local setContent button Continue alpha changes role=status to done-alpha; assert actual DOM and return {name,status}; independent harness with name=alpha; no imports of other Modules, navigation, network, files"}, Args: map[string]StageArgument{"name": {Kind: "binding", StageID: seed.ID, Path: []string{"name"}}}}
	proposed := []PlanStageInput{seed, next}
	if full {
		proposed = append(proposed, PlanStageInput{ID: "confirm", Title: "Confirm bound outcome without page mutation", Action: "create", Module: &PlannedModule{Slug: "m12-confirm", ModuleKind: "step", Description: "export run({page,name,status}); only read existing page, assert name alpha and status done-alpha matches actual role=status; never mutate/navigate/setContent. Return {name,status,confirmed:true}. Independent harness must create existing status fixture first; no other Module imports."}, Args: map[string]StageArgument{"name": {Kind: "binding", StageID: next.ID, Path: []string{"name"}}, "status": {Kind: "binding", StageID: next.ID, Path: []string{"status"}}}})
	}
	if reviewed {
		reviewedPlan, e := p.SavePlan(ctx, item.ID, editing.ID, editing.Draft.Revision, 0, proposed)
		if e != nil {
			t.Fatal(e)
		}
		save("reviewed-plan.json", reviewedPlan)
	} else {
		sub, err := p.CreateAuthor(ctx, item.ID, editing.ID, prompt, editing.Draft.Revision)
		if err != nil {
			t.Fatal(err)
		}
		a = claim("author")
		if a.ID != sub.Run.ID {
			t.Fatal("planner binding")
		}
		worker("planner", []any{map[string]any{"name": "catalog_search", "arguments": map[string]any{"query": "setup", "limit": 10}}, map[string]any{"name": "catalog_get", "arguments": map[string]any{"moduleVersionId": seedVersion.ID}}, map[string]any{"name": "propose_plan", "arguments": map[string]any{"stages": proposed}}, map[string]any{"final": map[string]any{"message": "Plan已保存，等待人工確認"}}})
	}

	plan, err := p.Plan(ctx, item.ID, editing.ID)
	if plan != nil {
		save("plan-observed.json", plan)
	}
	if err != nil || plan == nil || plan.Status != "draft" || len(plan.Stages) != newModules+1 || plan.Stages[0].Action != "reuse" || plan.Stages[0].ModuleVersionID != seed.ModuleVersionID || plan.Stages[1].Action != "create" || plan.Stages[1].Module == nil || plan.Stages[1].Module.Slug != "m12-verify" {
		t.Fatal("Plan did not preserve fixture contract", err)
	}
	binding, ok := plan.Stages[1].Args["name"]
	if !ok || binding.Kind != "binding" || binding.StageID != plan.Stages[0].ID || jsonText(binding.Path) != `["name"]` {
		t.Fatal("Plan lost upstream name binding")
	}
	if full {
		last := plan.Stages[2]
		if last.Action != "create" || last.Module == nil || last.Module.Slug != "m12-confirm" {
			t.Fatal("second new Module absent")
		}
		for _, key := range []string{"name", "status"} {
			b, ok := last.Args[key]
			if !ok || b.Kind != "binding" || b.StageID != plan.Stages[1].ID || jsonText(b.Path) != jsonText([]string{key}) {
				t.Fatal("second Module lost upstream binding")
			}
		}
	}
	save("plan-before-confirm.json", plan)
	plan, err = p.ConfirmPlan(ctx, plan.ID, plan.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a = claim("author")
	script := `import {expect} from '@playwright/test';export async function run({page,name}){await page.setContent('<button>Continue '+name+'</button><p role="status">pending</p>');await page.getByRole('button',{name:'Continue '+name}).evaluate((b)=>b.addEventListener('click',()=>document.querySelector('[role=status]').textContent='done-alpha'));await page.getByRole('button',{name:'Continue '+name}).click();await expect(page.getByRole('status')).toHaveText('done-alpha');return {name,status:await page.getByRole('status').innerText()}}`
	harness := `import {test,expect} from '@playwright/test';import {run} from '@lib/m12-verify';test('actual outcome',async({page})=>{expect(await run({page,name:'alpha'})).toEqual({name:'alpha',status:'done-alpha'});await expect(page.getByRole('status')).toHaveText('done-alpha')});`
	metadata := map[string]any{"slug": "m12-verify", "moduleKind": "step", "exportName": "run", "signature": "run({page,name})", "inputs": "name:string", "returns": "{name,status}", "preconditions": "fresh page, name=alpha", "postconditions": "actual DOM status done-alpha"}
	worker("module", []any{map[string]any{"name": "stage_module_candidate_part", "arguments": map[string]any{"part": "script", "stagingRevision": 0, "content": script}}, map[string]any{"name": "stage_module_candidate_part", "arguments": map[string]any{"part": "harness", "stagingRevision": 1, "content": harness}}, map[string]any{"name": "commit_module_candidate", "arguments": map[string]any{"stagingRevision": 2, "metadata": metadata}}})
	a = claim("validation")
	moduleAssignment := a
	validate("module-validation")
	// Independent fixed acceptance is separate evidence, never a changed formal
	// bundle. It executes the original body and checks the actual visible outcome.
	independent := `import {test,expect} from '@playwright/test';import {run} from '@lib/m12-verify';test('independent acceptance',async({page})=>{const value=await run({page,name:'alpha'});expect(value).toEqual({name:'alpha',status:'done-alpha'});await expect(page.getByRole('status')).toHaveText('done-alpha');});`
	independentFiles := []RunFile{}
	for _, f := range moduleAssignment.Files {
		if f.Path == "tests/test.spec.ts" {
			f.Content = independent
		}
		independentFiles = append(independentFiles, f)
	}
	_, _ = runBrowser("independent-acceptance", map[string]any{"runId": NewID(), "attemptId": NewID(), "files": independentFiles, "moduleAbi": moduleAssignment.ModuleABI, "timeoutMs": moduleAssignment.TimeoutMS, "workspaceId": moduleAssignment.WorkspaceID, "testId": moduleAssignment.TestID, "workspaceContext": moduleAssignment.WorkspaceContext, "workspaceSettings": moduleAssignment.WorkspaceSettings, "scriptOrigin": moduleAssignment.ScriptOrigin})
	if full {
		a = claim("author")
		body2 := `import {expect} from '@playwright/test';export async function run({page,name,status}){expect(name).toBe('alpha');expect(status).toBe('done-alpha');await expect(page.getByRole('status')).toHaveText(status);return {name,status,confirmed:true}}`
		spec2 := `import {test,expect} from '@playwright/test';import {run} from '@lib/m12-confirm';test('preserve page and confirm status',async({page})=>{await page.setContent('<h1>alpha</h1><p role="status">done-alpha</p>');const before=await page.content();expect(await run({page,name:'alpha',status:'done-alpha'})).toEqual({name:'alpha',status:'done-alpha',confirmed:true});expect(await page.content()).toBe(before)});`
		meta2 := map[string]any{"slug": "m12-confirm", "moduleKind": "step", "exportName": "run", "signature": "run({page,name,status})", "inputs": "name,status", "returns": "{name,status,confirmed:true}", "preconditions": "existing page has role=status done-alpha", "postconditions": "matching actual status confirmed; page unchanged"}
		worker("module-confirm", []any{map[string]any{"name": "stage_module_candidate_part", "arguments": map[string]any{"part": "script", "stagingRevision": 0, "content": body2}}, map[string]any{"name": "stage_module_candidate_part", "arguments": map[string]any{"part": "harness", "stagingRevision": 1, "content": spec2}}, map[string]any{"name": "commit_module_candidate", "arguments": map[string]any{"stagingRevision": 2, "metadata": meta2}}})
		a = claim("validation")
		secondAssignment := a
		validate("module-confirm-validation")
		files2 := []RunFile{}
		for _, f := range secondAssignment.Files {
			if f.Path == "tests/test.spec.ts" {
				f.Content = spec2
			}
			files2 = append(files2, f)
		}
		_, _ = runBrowser("independent-confirm-acceptance", map[string]any{"runId": NewID(), "attemptId": NewID(), "files": files2, "moduleAbi": secondAssignment.ModuleABI, "timeoutMs": secondAssignment.TimeoutMS, "workspaceId": secondAssignment.WorkspaceID, "testId": secondAssignment.TestID, "workspaceContext": secondAssignment.WorkspaceContext, "workspaceSettings": secondAssignment.WorkspaceSettings, "scriptOrigin": secondAssignment.ScriptOrigin})
	}
	plan, err = p.Plan(ctx, item.ID, editing.ID)
	if err != nil || plan.Status != "composed" || plan.ValidationRunID == nil {
		t.Fatal("Compose unavailable", err)
	}
	a = claim("validation")
	if a.ID != *plan.ValidationRunID {
		t.Fatal("Use Case validation binding")
	}
	validate("usecase-validation")
	plan, err = p.Plan(ctx, item.ID, editing.ID)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := p.CreatePlanSummary(ctx, plan.ID, plan.Revision, *plan.ValidationRunID)
	if err != nil {
		t.Fatal(err)
	}
	a = claim("author")
	if a.ID != summary.ID {
		t.Fatal("summary binding")
	}
	worker("summary", []any{map[string]any{"final": map[string]any{"message": "已驗證本機合成頁流程，尚待人工發佈", "description": "複用setup傳入alpha，按鈕點擊後以獨立斷言驗證done-alpha", "backgroundSummary": "僅涵蓋本機DOM fixture；不代表真外部網站或登入", "name": "M12 local outcome"}}})
	view, err := p.PlanSummary(ctx, plan.ID)
	if err != nil || view == nil || !view.PublishReady || len(view.Candidates) != newModules {
		t.Fatal("batch summary not publishable", err)
	}
	save("plan-ready.json", plan)
	save("summary-ready.json", view)
	// The UI uses a candidate Server against this one disposable schema.
	var schema string
	if err = p.DB.QueryRowContext(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	dsn, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	q := dsn.Query()
	q.Set("search_path", schema)
	dsn.RawQuery = q.Encode()
	command := exec.CommandContext(ctx, "node", repositoryFile("scripts", "test", "m12-usecase-publish-ui.mjs"), os.Getenv("WHIPPET_M12_USECASE_SERVER"), filepath.Join(out, "ui"))
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "TEST_DATABASE_URL=" + dsn.String()}
	command.Stdin = strings.NewReader(jsonText(map[string]any{"testId": item.ID, "sessionId": editing.ID, "planId": plan.ID, "planRevision": plan.Revision, "summaryRunId": summary.ID, "artifactDir": files.root, "newModules": newModules, "wave": wave}))
	raw, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("publication UI: %v %s", err, raw)
	}
	var publication struct {
		Status               string `json:"status"`
		PublishedVersionID   string `json:"publishedVersionId"`
		PublishedModuleCount int    `json:"publishedModuleCount"`
	}
	if json.Unmarshal(raw, &publication) != nil || publication.Status != "PASS" || !ValidID(publication.PublishedVersionID) || publication.PublishedModuleCount != newModules {
		t.Fatal("UI publication receipt")
	}
	save("publication-ui.json", json.RawMessage(raw))
	if full {
		run, e := p.CreateRun(ctx, item.ID)
		if e != nil {
			t.Fatal(e)
		}
		a = claim("run")
		stored, e := p.Run(ctx, a.ID)
		if e != nil || a.ID != run.ID || stored.VersionID == nil || *stored.VersionID != publication.PublishedVersionID {
			t.Fatal("published execution version mismatch")
		}
		validate("published-execution")
		run, e = p.Run(ctx, a.ID)
		if e != nil || run.Status != "succeeded" {
			t.Fatal("published run completion", e)
		}
		save("published-run.json", run)
	}
	save("result.json", map[string]any{"status": "PASS", "mode": mode, "assistedPlanReview": reviewed, "replayedModuleArtifacts": os.Getenv("WHIPPET_M12_USECASE_REPLAY") != "", "engine": "vercel", "paidModels": mode == "live", "roles": receipts, "formalPlaywrightRuns": 3 + 2*(newModules-1), "postPublicationRun": full, "newModules": newModules, "independentAcceptancePassed": true, "publishedModuleCount": publication.PublishedModuleCount, "scriptedControlConfirmation": true, "uiPublication": true, "golden14UnassistedProven": false})
	t.Log("representative Use Case complete: real Plan/Stage/Compose, keyless Docker Playwright, batch summary and atomic publication")
}
