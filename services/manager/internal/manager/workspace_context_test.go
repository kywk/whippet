package manager

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func m8Config() map[string]any {
	return map[string]any{"name": "合成工作區", "purpose": "登入驗測", "backgroundSummary": "保留背景", "targets": []any{map[string]any{"name": "網站", "purpose": "主要目標", "origin": "https://example.test"}}, "dependencies": []any{}, "excludedOrigins": []any{}, "exclusions": "", "loginRoles": []any{}, "defaultTestUrl": "https://example.test/tasks", "timeoutMs": 60000}
}
func m8Dispatch(t *testing.T) Dispatch {
	t.Helper()
	d := authorDispatch()
	d.WorkspaceID = newID()
	d.TestID = json.RawMessage(`null`)
	payload := map[string]any{"conversationId": newID(), "baseRevision": 1, "messages": []AuthorMessage{{Role: "user", Content: "訪談用途與設定"}}, "skillId": "workspace-author", "skillVersion": "1", "editingSessionId": nil, "sourceVersion": nil, "contextRevision": 0, "conversationSummary": nil, "allowedTools": []string{}}
	data, _ := json.Marshal(payload)
	if err := json.Unmarshal(data, &d.Author); err != nil {
		t.Fatal(err)
	}
	d.WorkspaceContext, _ = json.Marshal(map[string]any{"schemaVersion": "1", "workspaceId": d.WorkspaceID, "settingsRevision": 1, "config": nil, "roleRefs": []any{}})
	return d
}

func TestM8WorkspaceAuthorFlatInputJournalDedupCancel(t *testing.T) {
	m, driver, ctx := lifecycleManager(t, 1)
	d := m8Dispatch(t)
	if err := validDispatch(d); err != nil {
		t.Fatal(err)
	}
	env := message("manager-test", "dispatch", newID(), newID(), d)
	task := driver.add(env)
	if err := m.accept(ctx, env); err != nil && err.Error() != "Manager is offline" {
		t.Fatal(err)
	}
	awaitAttempt(t, driver.started, env.AttemptID)
	if err := m.accept(ctx, env); err != nil && err.Error() != "Manager is offline" {
		t.Fatal(err)
	}
	r := journalRecord(m, env.AttemptID)
	body, err := os.ReadFile(filepath.Join(m.taskDir(r), "input.json"))
	if err != nil {
		t.Fatal(err)
	}
	var input WorkerInput
	if err = json.Unmarshal(body, &input); err != nil {
		t.Fatal(err)
	}
	if input.WorkspaceID != d.WorkspaceID || string(input.TestID) != "null" || !reflect.DeepEqual(input.Author, d.Author) || !strings.Contains(string(body), `"editingSessionId":null`) {
		t.Fatal("flat input lost Workspace owner or nullable session")
	}
	loaded, err := loadRecords(m.cfg.WorkDir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded[r.AttemptID].Author, d.Author) || string(loaded[r.AttemptID].WorkspaceContext) != string(d.WorkspaceContext) {
		t.Fatal("journal lost trusted nonsecret snapshot")
	}
	if err := m.startLive(ctx, message("manager-test", "live.start", r.RunID, r.AttemptID, map[string]any{"viewerId": newID()})); err == nil {
		t.Fatal("interview offered live browser")
	}
	if err := m.cancelAttempt(ctx, message("manager-test", "cancel", r.RunID, r.AttemptID, struct{}{})); err != nil {
		t.Fatal(err)
	}
	awaitAttempt(t, driver.removing, r.AttemptID)
	if activeCount(t, m) != 1 {
		t.Fatal("released before reclaim")
	}
	close(task.reclaim)
	m.wg.Wait()
	if err := m.accept(context.Background(), env); err != nil && err.Error() != "Manager is offline" {
		t.Fatal(err)
	}
	driver.mu.Lock()
	defer driver.mu.Unlock()
	if task.starts != 1 {
		t.Fatal("same attempt reran")
	}
}

func TestM8WorkspaceRejectsUnknownSecretAuthorizationAndInvalidScope(t *testing.T) {
	for _, key := range []string{"requiredPolicyVersion", "owner", "workspaceSessionId", "password"} {
		d := m8Dispatch(t)
		raw, _ := json.Marshal(d)
		var object map[string]any
		json.Unmarshal(raw, &object)
		object[key] = 1
		raw, _ = json.Marshal(object)
		var decoded Dispatch
		if json.Unmarshal(raw, &decoded) == nil {
			t.Fatalf("accepted unknown %s", key)
		}
	}
	for _, mutate := range []func(*Dispatch){
		func(d *Dispatch) { d.WorkspaceID = newID() }, func(d *Dispatch) { d.TestID = json.RawMessage(`"` + newID() + `"`) }, func(d *Dispatch) { d.Author.BaseRevision = 2 },
		func(d *Dispatch) { tools := []string{"browser_navigate"}; d.Author.AllowedTools = &tools },
	} {
		d := m8Dispatch(t)
		mutate(&d)
		if validDispatch(d) == nil {
			t.Fatal("invalid Workspace author snapshot accepted")
		}
	}
	d := m8Dispatch(t)
	d.Kind = "run"
	d.Author = nil
	d.TestID = json.RawMessage(`"` + newID() + `"`)
	d.Script = "untrusted spec"
	if err := validDispatch(d); err == nil || err.Error() != "scope_confirmation_required" {
		t.Fatal("M8 run silently fell back to unrestricted bridge", err)
	}
	edit := m7Dispatch(t, false)
	edit.WorkspaceID = d.WorkspaceID
	edit.TestID = d.TestID
	edit.WorkspaceContext = d.WorkspaceContext
	tools := []string{"read_draft", "read_validation_report", "update_draft"}
	edit.Author.AllowedTools = &tools
	if err := validDispatch(edit); err != nil {
		t.Fatal("no-browser edit blocked", err)
	}
	tools = append(tools, "request_validation")
	edit.Author.AllowedTools = &tools
	if err := validDispatch(edit); err != nil {
		t.Fatal("B Server-granted validation incorrectly blocked", err)
	}
	d.ScriptOrigin = "manual"
	if err := validDispatch(d); err != nil {
		t.Fatal("manual full runner blocked without targets", err)
	}
	for _, mutate := range []func(map[string]any){
		func(c map[string]any) { c["headers"] = map[string]any{} }, func(c map[string]any) { c["purpose"] = strings.Repeat("x", 8193) },
		func(c map[string]any) { c["excludedOrigins"] = []string{"https://example.test:443/"} },
		func(c map[string]any) {
			c["excludedOrigins"] = []string{"https://excluded.test", "https://excluded.test:443/"}
		},
		func(c map[string]any) {
			c["dependencies"] = []any{map[string]any{"name": "衝突", "purpose": "api", "origin": "https://example.test:443/"}}
		},
		func(c map[string]any) {
			c["dependencies"] = []any{map[string]any{"name": "任意", "purpose": "target", "origin": "https://other.test"}}
		},
	} {
		c := m8Config()
		mutate(c)
		raw, _ := json.Marshal(c)
		if validWorkspaceConfig(raw, nil) == nil {
			t.Fatal("invalid config accepted")
		}
	}
	c := m8Config()
	c["excludedOrigins"] = []string{}
	for i := 0; i < 40; i++ {
		c["excludedOrigins"] = append(c["excludedOrigins"].([]string), "https://"+newID()+".test")
	}
	raw, _ := json.Marshal(c)
	if validWorkspaceConfig(raw, nil) != nil {
		t.Fatal("40 excluded origins rejected")
	}
}

func TestM8WorkspaceArtifactUsesJournalOwnerAndOnlyProposalSchema(t *testing.T) {
	m, _, _ := lifecycleManager(t, 1)
	d := m8Dispatch(t)
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "collecting", Result: &Result{Status: "succeeded"}, ResultMessageID: newID(), Reclaimed: true, Author: d.Author, WorkspaceID: d.WorkspaceID, TestID: d.TestID, WorkspaceContext: d.WorkspaceContext}
	if err := m.store(r); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadRecords(m.cfg.WorkDir)
	if err != nil {
		t.Fatal(err)
	}
	r = loaded[r.AttemptID]
	output := filepath.Join(m.taskDir(r), "output")
	os.MkdirAll(output, 0700)
	atomicJSON(filepath.Join(output, "result.json"), Result{Status: "succeeded"})
	good := map[string]any{"message": "待人工檢視，未探索網站", "proposal": m8Config(), "conversationSummary": "保留訪談背景"}
	file := filepath.Join(output, "author.json")
	atomicJSON(file, good)
	result, names := collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "succeeded" || !reflect.DeepEqual(names, []string{"author.json"}) {
		t.Fatal("interview required Playwright report or edit output", result, names)
	}
	for _, key := range []string{"confirmed", "scopeConfirmed", "secretRef", "requestValidation", "script", "workspaceId"} {
		bad := map[string]any{}
		for k, v := range good {
			bad[k] = v
		}
		bad[key] = true
		atomicJSON(file, bad)
		result, _ := collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
		if result.Status != "failed" {
			t.Fatal("accepted forbidden output field", key)
		}
	}
	c := m8Config()
	c["loginRoles"] = []any{map[string]any{"roleId": newID(), "name": "不屬此工作區", "loginMethod": "form", "loginOrigin": "https://example.test"}}
	good["proposal"] = c
	atomicJSON(file, good)
	result, _ = collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "failed" {
		t.Fatal("accepted unknown role UUID")
	}
	good["proposal"] = nil
	atomicJSON(file, good)
	result, _ = collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "failed" {
		t.Fatal("accepted null proposal")
	}
}
