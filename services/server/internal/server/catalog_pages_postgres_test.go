//go:build integration

package server

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"testing"
)

func TestM102CatalogPages(t *testing.T) {
	p, ctx, item, session, _ := m10PlanFixture(t)
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	manifest, pin, err := loadSkill(repositoryFile("runtimes", "worker", "skills"), "usecase-planner", registry)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	d, s, err := requireEditingDraft(ctx, tx, item.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	input := editingAuthorInput(s, d, "usecase-planner", []ChatMessage{{Role: "user", Content: "synthetic plan"}})
	input.SkillVersion = pin.Version
	input.Skills = []SkillSnapshot{pin}
	input.Platform = &AuthorPlatform{}
	input.Budget = &manifest.Budget
	input.Model = &manifest.Model
	input.ToolRegistryVersion = registry.Version
	input.ToolRegistrySHA256 = registry.SHA256
	input.AllowedTools = []string{"propose_plan", "read_plan", "catalog_get", "catalog_search", "catalog_next_page"}
	run, err := enqueueAuthorSnapshot(ctx, tx, d, input)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO managers(singleton,id,capacity) VALUES(true,'m10-platform',1)`); err != nil {
		t.Fatal(err)
	}
	attempt := NewID()
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='running',manager_id='m10-platform',attempt_id=$2,slot_released=false WHERE id=$1`, run.ID, attempt); err != nil {
		t.Fatal(err)
	}

	// Add another published Module without changing immutable source metadata.
	slug := "setup-second"
	module, err := p.CreatePlatformTest(ctx, item.WorkspaceID, "setup-second", "", "module", &slug)
	if err != nil {
		t.Fatal(err)
	}
	metadata := Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare", Harness: m10BundleSpec}
	version := NewID()
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO test_versions(id,test_id,version,script,timeout_ms,workspace_settings,module,script_origin) VALUES($1,$2,1,$3,60000,'{}',$4,'manual')`, version, module.ID, m10BundleModule, jsonText(metadata)); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, module.ID, version); err != nil {
		t.Fatal(err)
	}
	call := func(name string, args any, callID, runID, attemptID string, allowed bool) (json.RawMessage, error) {
		result, err := p.HarnessPlatform(ctx, "m10-platform", runID, attemptID, HarnessToolRequest{CallID: callID, Name: name, Arguments: json.RawMessage(jsonText(args))}, registry, func() bool { return allowed })
		if err != nil {
			return nil, err
		}
		return result.(json.RawMessage), nil
	}
	first, err := call("catalog_search", map[string]any{"query": "setup", "limit": 1}, NewID(), run.ID, attempt, true)
	if err != nil {
		t.Fatal(err)
	}
	var page struct {
		Items []json.RawMessage `json:"items"`
		Next  *string           `json:"nextCursor"`
	}
	if json.Unmarshal(first, &page) != nil || len(page.Items) != 1 || page.Next == nil {
		t.Fatal("first page missing")
	}
	cursor := *page.Next
	args := map[string]any{"cursor": cursor, "limit": 1}
	callID := NewID()
	second, err := call("catalog_next_page", args, callID, run.ID, attempt, true)
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(second, &page) != nil || len(page.Items) != 1 || page.Next != nil {
		t.Fatal("second page incorrect")
	}
	retry, err := call("catalog_next_page", args, callID, run.ID, attempt, true)
	var a, b any
	json.Unmarshal(second, &a)
	json.Unmarshal(retry, &b)
	if err != nil || !reflect.DeepEqual(a, b) {
		t.Fatal("replay changed")
	}
	if _, err = call("catalog_next_page", args, NewID(), run.ID, attempt, true); err != nil {
		t.Fatal("issued cursor reread rejected", err)
	}
	for _, bad := range []struct {
		name         string
		args         any
		run, attempt string
		allowed      bool
	}{
		{"extra_search_cursor", map[string]any{"query": "setup", "limit": 1, "cursor": nil}, run.ID, attempt, true},
		{"cross_run", args, NewID(), attempt, true},
		{"cross_attempt", args, run.ID, NewID(), true},
		{"epoch", args, run.ID, attempt, false},
		{"empty", map[string]any{"cursor": "", "limit": 1}, run.ID, attempt, true},
		{"forged", map[string]any{"cursor": base64.RawURLEncoding.EncodeToString([]byte(jsonText(catalogToolCursor{item.WorkspaceID, "other", module.ID}))), "limit": 1}, run.ID, attempt, true},
		{"cross_workspace", map[string]any{"cursor": base64.RawURLEncoding.EncodeToString([]byte(jsonText(catalogToolCursor{NewID(), "setup", module.ID}))), "limit": 1}, run.ID, attempt, true},
	} {
		t.Run(bad.name, func(t *testing.T) {
			name := "catalog_next_page"
			if bad.name == "extra_search_cursor" {
				name = "catalog_search"
			}
			if _, err := call(name, bad.args, NewID(), bad.run, bad.attempt, bad.allowed); err == nil {
				t.Fatal("rejected request accepted")
			}
		})
	}
	// Exercise issuance independently of active-attempt authorization.
	newAttempt := NewID()
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET attempt_id=$2 WHERE id=$1`, run.ID, newAttempt); err != nil {
		t.Fatal(err)
	}
	if _, err = call("catalog_next_page", args, NewID(), run.ID, newAttempt, true); err == nil {
		t.Fatal("new active attempt reused prior issuance")
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET attempt_id=$2 WHERE id=$1`, run.ID, attempt); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelled' WHERE id=$1`, run.ID); err != nil {
		t.Fatal(err)
	}
	otherTx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	other, err := enqueueAuthorSnapshot(ctx, otherTx, d, input)
	if err != nil {
		otherTx.Rollback()
		t.Fatal(err)
	}
	if err = otherTx.Commit(); err != nil {
		t.Fatal(err)
	}
	otherAttempt := NewID()
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='running',manager_id='m10-platform',attempt_id=$2,slot_released=false WHERE id=$1`, other.ID, otherAttempt); err != nil {
		t.Fatal(err)
	}
	if _, err = call("catalog_next_page", args, NewID(), other.ID, otherAttempt, true); err == nil {
		t.Fatal("other active Run reused issuance")
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelled' WHERE id=$1`, other.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='running' WHERE id=$1`, run.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = call("catalog_next_page", map[string]any{"cursor": cursor, "limit": 2}, callID, run.ID, attempt, true); err == nil {
		t.Fatal("changed body replay accepted")
	}
	// All persisted top-level cursor producers belong to the two catalog operations
	// above. Model-controlled data remains nested and cannot mint such a field.
	get, err := call("catalog_get", map[string]any{"moduleVersionId": version}, NewID(), run.ID, attempt, true)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]json.RawMessage
	json.Unmarshal(get, &object)
	if _, ok := object["nextCursor"]; ok {
		t.Fatal("non-catalog producer minted cursor")
	}
	if _, err = p.DB.ExecContext(ctx, `UPDATE runs SET status='cancelled' WHERE id=$1`, run.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = call("catalog_next_page", args, callID, run.ID, attempt, true); err == nil {
		t.Fatal("cancelled replay accepted")
	}
}
