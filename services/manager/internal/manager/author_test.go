package manager

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func authorDispatch() Dispatch {
	return Dispatch{Kind: "author", Script: "", TimeoutMS: 180000, Author: &AuthorTask{ConversationID: newID(), BaseRevision: 1, Messages: []AuthorMessage{{Role: "user", Content: "synthetic test goal"}}}}
}

func TestM3AuthorWhitelistAndIndependentEntrypoint(t *testing.T) {
	d := dockerCLI{cfg: Config{WorkerImage: "fixture", ManagerID: "synthetic"}}
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author"}
	args := d.createArgs(r, "/synthetic/work")
	if got := strings.Join(args[len(args)-3:], " "); got != "fixture node dist/author/main.js" {
		t.Fatalf("unexpected author command: %s", got)
	}
	parent := []string{"PATH=/bin", "OPENCODE_API_KEY=synthetic-key", "WHIPPET_AI_ENABLED=true", "MANAGER_TOKEN=not-forwarded"}
	if strings.Contains(strings.Join(args, " "), "synthetic-key") {
		t.Fatal("credential was put into process arguments")
	}
	for _, name := range authorEnvNames {
		if !strings.Contains(strings.Join(args, " "), "--env "+name) {
			t.Fatalf("missing author whitelist entry %s", name)
		}
	}
	r.Kind = "run"
	if strings.Contains(strings.Join(d.createArgs(r, "/synthetic/work"), " "), "--env") || strings.Contains(strings.Join(workerCLIEnvironment("run", parent), " "), "synthetic-key") {
		t.Fatal("ordinary run inherited AI configuration/key")
	}
	if !strings.Contains(strings.Join(workerCLIEnvironment("author", parent), " "), "OPENCODE_API_KEY=synthetic-key") {
		t.Fatal("author CLI environment did not receive explicit key")
	}
}

func TestM3AuthorInputJournalAndArtifactIsolation(t *testing.T) {
	m, _, ctx := lifecycleManager(t, 1)
	d := authorDispatch()
	if err := validDispatch(d); err != nil {
		t.Fatal(err)
	}
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "accepted", TimeoutMS: d.TimeoutMS, ResultMessageID: newID()}
	if err := m.store(r); err != nil {
		t.Fatal(err)
	}
	if err := m.prepare(r, d); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{m.journalPath(r), filepath.Join(m.taskDir(r), "input.json")} {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), "OPENCODE_API_KEY") || strings.Contains(string(body), "WHIPPET_AI_") {
			t.Fatal("AI environment leaked into task files")
		}
	}
	if err := os.Mkdir(filepath.Join(m.taskDir(r), "output"), 0700); err != nil {
		t.Fatal(err)
	}
	atomicJSON(filepath.Join(m.taskDir(r), "output", "result.json"), Result{Status: "succeeded"})
	atomicJSON(filepath.Join(m.taskDir(r), "output", "author.json"), map[string]any{"message": "合成草稿", "script": "candidate only", "requestValidation": true})
	result, artifacts := collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "succeeded" || len(artifacts) != 1 || artifacts[0] != "author.json" {
		t.Fatalf("unexpected author result: %+v %v", result, artifacts)
	}
	if artifactAllowed(record{Kind: "run"}, "author.json") || artifactAllowed(r, "report.html") {
		t.Fatal("artifact allowlist did not follow kind")
	}
	if err := m.upload(ctx, record{Kind: "run"}, "author.json"); err == nil {
		t.Fatal("ordinary run could upload author artifact")
	}
	atomicJSON(filepath.Join(m.taskDir(r), "output", "result.json"), Result{Status: "failed", Error: "synthetic-key-provider-error"})
	result, artifacts = collectAttemptResult(r, m.taskDir(r), execution{ExitCode: 1, Error: "synthetic-key-container-error"})
	if strings.Contains(result.Error, "synthetic-key") || len(artifacts) != 0 {
		t.Fatal("author failure leaked raw error or candidate")
	}
	loaded, err := loadRecords(m.cfg.WorkDir)
	if err != nil || loaded[r.AttemptID].Kind != "author" {
		t.Fatal("author kind did not survive journal reload")
	}
}

func TestM3AuthorSharesCapacityCancelAndDedup(t *testing.T) {
	m, d, ctx := lifecycleManager(t, 1)
	author := authorDispatch()
	dispatch := message("manager-test", "dispatch", newID(), newID(), author)
	task := d.add(dispatch)
	_ = m.accept(ctx, dispatch)
	awaitAttempt(t, d.started, dispatch.AttemptID)
	_ = m.accept(ctx, dispatch)
	if err := m.accept(ctx, dispatchForTest()); err == nil || !strings.Contains(err.Error(), "MAX_WORKERS") {
		t.Fatal("author did not share the run Worker slot")
	}
	if err := m.cancelAttempt(ctx, message("manager-test", "cancel", dispatch.RunID, dispatch.AttemptID, struct{}{})); err != nil {
		t.Fatal(err)
	}
	awaitAttempt(t, d.removing, dispatch.AttemptID)
	if activeCount(t, m) != 1 {
		t.Fatal("author cancellation released before cleanup")
	}
	close(task.reclaim)
	m.wg.Wait()
	r := journalRecord(m, dispatch.AttemptID)
	if r.Result.Status != "cancelled" || !r.Reclaimed || r.Kind != "author" {
		t.Fatalf("invalid author cancellation state: %+v", r)
	}
	_ = m.accept(context.Background(), dispatch)
	d.mu.Lock()
	defer d.mu.Unlock()
	if task.starts != 1 {
		t.Fatal("author attempt reran")
	}
}

func TestM3AuthorProgressOnlyAllowsFixedMetadata(t *testing.T) {
	m, _, _ := lifecycleManager(t, 1)
	r := record{Kind: "author", RunID: newID(), AttemptID: newID()}
	m.emit(r, "log", "raw provider body synthetic-key")
	m.emit(r, "log", "author:tool:1:browser_fill:succeeded secret arguments")
	if len(m.events) != 0 {
		t.Fatal("unsafe author log was forwarded")
	}
	m.emit(r, "log", "author:tool:1:browser_fill:succeeded")
	var payload struct{ Message string }
	json.Unmarshal((<-m.events).Payload, &payload)
	if payload.Message != "author:tool:1:browser_fill:succeeded" {
		t.Fatal("fixed author progress was not forwarded")
	}
}

func TestM3AuthorOptionalValidationSnapshot(t *testing.T) {
	d := authorDispatch()
	if err := validDispatch(d); err != nil {
		t.Fatal(err)
	}
	d.Author.Validation = &AuthorValidation{RunID: newID(), Status: "failed", Error: "synthetic assertion summary"}
	if err := validDispatch(d); err != nil {
		t.Fatal(err)
	}
	m, _, _ := lifecycleManager(t, 1)
	r := record{RunID: newID(), AttemptID: newID(), Kind: "author"}
	if err := m.prepare(r, d); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(m.taskDir(r), "input.json"))
	if err != nil {
		t.Fatal(err)
	}
	var parsed WorkerInput
	if err := json.Unmarshal(data, &parsed); err != nil || parsed.Author.Validation.Error != d.Author.Validation.Error {
		t.Fatal("validation snapshot was not forwarded")
	}
	d.Author.Validation.Error = strings.Repeat("字", 4001)
	if err := validDispatch(d); err == nil {
		t.Fatal("oversized validation error was accepted")
	}
	if !authorProgressPattern.MatchString("author:tool:1:read_validation_report:succeeded") {
		t.Fatal("validation progress was not allowed")
	}
}
