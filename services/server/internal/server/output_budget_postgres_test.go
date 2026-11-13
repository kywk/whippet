//go:build integration

package server

import (
	"encoding/json"
	"testing"
)

func TestM109OutputBudgetRetrySnapshot(t *testing.T) {
	root := m10SkillRoot(t)
	setOutputBudget(t, root, "module-authoring", nil)
	p, ctx, plan, body := retryFixture(t, false)
	source := *plan.Stages[1].AuthorRunID
	read := func(id string) string {
		t.Helper()
		var raw string
		if err := p.DB.QueryRowContext(ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, id).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		return raw
	}
	before := read(source)
	var old AuthorInput
	if err := json.Unmarshal([]byte(before), &old); err != nil {
		t.Fatal(err)
	}
	if old.Budget.MaxOutputTokens != nil || old.Budget.effectiveMaxOutputTokens() != 8192 {
		t.Fatal("not legacy fixture")
	}
	setOutputBudget(t, root, "module-authoring", 16384)
	next, err := p.RetryPlanStage(ctx, plan.ID, "repair", body)
	if err != nil {
		t.Fatal(err)
	}
	newID := *next.Stages[1].AuthorRunID
	var fresh AuthorInput
	if err := json.Unmarshal([]byte(read(newID)), &fresh); err != nil {
		t.Fatal(err)
	}
	if fresh.Budget.effectiveMaxOutputTokens() != 16384 || fresh.Skills[0].ManifestSHA256 == old.Skills[0].ManifestSHA256 || fresh.SkillVersion != old.SkillVersion {
		t.Fatal("new snapshot cap/pin")
	}
	if fresh.Budget.MaxModelRequests != old.Budget.MaxModelRequests || fresh.Budget.MaxToolCalls != old.Budget.MaxToolCalls || fresh.Budget.MaxDurationMS != old.Budget.MaxDurationMS {
		t.Fatal("other budget changed")
	}
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"stage_module_candidate_part", "commit_module_candidate"} {
		if validateToolSnapshot(fresh, registry, tool) != nil {
			t.Fatal("bounded tool missing from fresh retry", tool)
		}
	}
	if validateToolSnapshot(fresh, registry, "update_module_candidate") == nil {
		t.Fatal("fresh retry exposes full candidate tool")
	}
	if len(fresh.Messages) == 0 || fresh.Messages[len(fresh.Messages)-1].Content != body.Content {
		t.Fatal("retry content changed")
	}
	replay, err := p.RetryPlanStage(ctx, plan.ID, "repair", body)
	if err != nil || *replay.Stages[1].AuthorRunID != newID {
		t.Fatal("retry idempotency", err)
	}
	if read(source) != before {
		t.Fatal("old payload rewritten")
	}
	var count int
	if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM plan_stage_retries WHERE plan_id=$1`, plan.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("retry count", count, err)
	}
	assignment, err := p.Claim(ctx, "retry-manager", 1)
	if err != nil || assignment == nil || assignment.ID != newID || assignment.Author.Budget.effectiveMaxOutputTokens() != 16384 {
		t.Fatal("dispatch", err)
	}
	if read(source) != before {
		t.Fatal("dispatch rewrote old payload")
	}
}
