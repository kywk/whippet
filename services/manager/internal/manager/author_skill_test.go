package manager

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func m7Dispatch(t *testing.T, summary bool) Dispatch {
	t.Helper()
	d := authorDispatch()
	d.Script = "throw new Error('candidate must not execute in author')"
	mode := "test-author"
	tools := []string{"read_draft", "update_draft", "request_validation"}
	messages := []AuthorMessage{{Role: "user", Content: "synthetic test goal"}}
	if summary {
		mode = "acceptance-summary"
		tools = []string{}
		messages = []AuthorMessage{}
	}
	payload := map[string]any{"skillId": mode, "skillVersion": "1", "allowedTools": tools, "editingSessionId": newID(), "contextRevision": 0,
		"conversationId": newID(), "baseRevision": 3, "messages": messages, "sourceVersion": map[string]any{"id": newID(), "description": "saved version description", "backgroundSummary": nil}, "conversationSummary": nil}
	if summary {
		payload["validationEvidence"] = map[string]any{"runId": newID(), "attemptId": newID(), "draftRevision": 3, "scriptHash": fmt.Sprintf("%x", sha256.Sum256([]byte(d.Script))), "timeoutMs": 60000, "status": "succeeded", "reportsReady": true, "stats": map[string]any{"expected": 1, "unexpected": 0, "flaky": 0, "skipped": 0, "duration": 2.5}}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var a AuthorTask
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatal(err)
	}
	d.Author = &a
	return d
}

func TestM7AuthorSnapshotPassesInputAndJournalWithoutLosingNullOrEmptyArrays(t *testing.T) {
	m, _, _ := lifecycleManager(t, 1)
	for _, summary := range []bool{false, true} {
		d := m7Dispatch(t, summary)
		if err := validDispatch(d); err != nil {
			t.Fatal(err)
		}
		r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "accepted", TimeoutMS: 180000, ResultMessageID: newID(), Author: d.Author}
		if err := m.store(r); err != nil {
			t.Fatal(err)
		}
		if err := m.prepare(r, d); err != nil {
			t.Fatal(err)
		}
		body, err := os.ReadFile(filepath.Join(m.taskDir(r), "input.json"))
		if err != nil {
			t.Fatal(err)
		}
		var input WorkerInput
		if err := json.Unmarshal(body, &input); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(input.Author, d.Author) || input.TimeoutMS != 180000 {
			t.Fatal("trusted author input changed")
		}
		loaded, err := loadRecords(m.cfg.WorkDir)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(loaded[r.AttemptID].Author, d.Author) {
			t.Fatal("journal lost fixed author context")
		}
		if strings.Contains(string(body), "OPENCODE_API_KEY") || strings.Contains(string(body), `"mode"`) || strings.Contains(string(body), `"context"`) {
			t.Fatal("unexpected metadata or credentials")
		}
		if summary && (input.Author.Messages == nil || len(input.Author.Messages) != 0 || input.Author.AllowedTools == nil || len(*input.Author.AllowedTools) != 0) {
			t.Fatal("summary lost empty arrays")
		}
	}
	if err := validDispatch(authorDispatch()); err != nil {
		t.Fatal("legacy author input failed", err)
	}
}

func TestM7AuthorRejectsPartialPinWrongSchemaAndUnboundEvidence(t *testing.T) {
	mutators := []func(map[string]any){
		func(m map[string]any) { m["skillVersion"] = "2" }, func(m map[string]any) { delete(m, "contextRevision") }, func(m map[string]any) { m["mode"] = "summary" },
		func(m map[string]any) { m["context"] = map[string]any{} }, func(m map[string]any) { m["allowedTools"] = []string{"update_draft"} }, func(m map[string]any) { m["messages"] = nil },
		func(m map[string]any) {
			m["validationEvidence"].(map[string]any)["scriptHash"] = strings.Repeat("0", 64)
		},
		func(m map[string]any) { m["validationEvidence"].(map[string]any)["draftRevision"] = 2 },
		func(m map[string]any) {
			delete(m["validationEvidence"].(map[string]any)["stats"].(map[string]any), "duration")
		},
	}
	for _, mutate := range mutators {
		d := m7Dispatch(t, true)
		body, _ := json.Marshal(d.Author)
		var object map[string]any
		json.Unmarshal(body, &object)
		mutate(object)
		body, _ = json.Marshal(object)
		var author AuthorTask
		if json.Unmarshal(body, &author) != nil {
			continue
		}
		d.Author = &author
		if err := validDispatch(d); err == nil {
			t.Fatal("invalid M7 snapshot accepted")
		}
	}
	var author AuthorTask
	if json.Unmarshal([]byte(`{"skillId":null}`), &author) == nil {
		t.Fatal("partial null skill pin became legacy")
	}
}

func TestM7AuthorArtifactSchemaComesFromSavedInputNotArtifactMetadata(t *testing.T) {
	d := m7Dispatch(t, true)
	m, _, _ := lifecycleManager(t, 1)
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "collecting", Result: &Result{Status: "succeeded"}, ResultMessageID: newID(), Reclaimed: true, Author: d.Author}
	if err := m.store(r); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(m.taskDir(r), "output"), 0700); err != nil {
		t.Fatal(err)
	}
	atomicJSON(filepath.Join(m.taskDir(r), "output/result.json"), Result{Status: "succeeded"})
	good := map[string]any{"message": "摘要完成", "description": "目的／前置條件／步驟／檢查／限制", "backgroundSummary": "非機密背景", "name": "候選名稱"}
	file := filepath.Join(m.taskDir(r), "output/author.json")
	atomicJSON(file, good)
	loaded, err := loadRecords(m.cfg.WorkDir)
	if err != nil {
		t.Fatal(err)
	}
	r = loaded[r.AttemptID]
	result, names := collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "succeeded" || len(names) != 1 || names[0] != "author.json" {
		t.Fatal("recovered summary required edit flags or Playwright reports")
	}
	for _, extra := range []string{"script", "requestValidation", "skillId", "editingSessionId"} {
		bad := map[string]any{}
		for k, v := range good {
			bad[k] = v
		}
		bad[extra] = "forbidden"
		atomicJSON(file, bad)
		result, _ := collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
		if result.Status != "failed" {
			t.Fatal("summary accepted extra fields")
		}
	}
	good["description"] = strings.Repeat("測", 6000)
	atomicJSON(file, good)
	result, _ = collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "failed" {
		t.Fatal("description UTF-8 byte limit ignored")
	}
	edit := m7Dispatch(t, false)
	r.Author = edit.Author
	atomicJSON(file, map[string]any{"message": "候選", "requestValidation": true, "script": "unexecuted", "conversationSummary": "已保存背景"})
	result, _ = collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "succeeded" {
		t.Fatal("edit context summary rejected")
	}
	r.Author = nil
	atomicJSON(file, map[string]any{"message": "legacy", "requestValidation": false})
	result, _ = collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "succeeded" {
		t.Fatal("legacy output broke")
	}
	// Workspace test-author artifacts must only accept valid Playwright specs when a script is emitted
	r.Author = edit.Author
	r.WorkspaceContext = json.RawMessage(`{"schemaVersion":"1","workspaceId":"` + newID() + `","settingsRevision":1,"config":null,"roleRefs":[]}`)
	atomicJSON(file, map[string]any{"message": "非 Playwright 程式碼", "requestValidation": false, "script": "def hello():\n  print('not playwright')"})
	result, _ = collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "failed" {
		t.Fatal("manager accepted non-Playwright script in Workspace test-author output")
	}
	atomicJSON(file, map[string]any{"message": "已驗證 Playwright 腳本", "requestValidation": true, "script": "import { test, expect } from '@playwright/test';\ntest('smoke', async ({ page }) => { await expect(page).toBeTruthy(); });\n"})
	result, _ = collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "succeeded" {
		t.Fatal("manager rejected valid Playwright spec in Workspace test-author output")
	}
}
