//go:build integration

package server

import (
	"fmt"
	"strings"
	"testing"

	"github.com/whippet/whippet/services/server/migrations"
)

func TestM10PostgresUpgradeFromM9(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".sql") || name >= "011" {
			continue
		}
		body, err := migrations.Files.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.ExecContext(ctx, string(body)); err != nil {
			t.Fatalf("M9 fixture migration %s: %v", name, err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO schema_migrations(name) VALUES($1)`, name); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var test, version string
	if err = p.DB.QueryRowContext(ctx, `SELECT test_id,id FROM test_versions ORDER BY id LIMIT 1`).Scan(&test, &version); err != nil {
		t.Fatal(err)
	}
	run := NewID()
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO runs(id,test_id,workspace_id,version_id,script_snapshot,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin) SELECT $1,t.id,t.workspace_id,v.id,v.script,v.script_hash,v.timeout_ms,v.workspace_settings,v.workspace_context,'manual' FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.id=$2`, run, version); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var raw string
		err := p.DB.QueryRowContext(ctx, `SELECT jsonb_build_object('tests',(SELECT jsonb_agg(jsonb_build_array(id,workspace_id,name,description,published_version_id) ORDER BY id) FROM tests),'versions',(SELECT jsonb_agg(jsonb_build_array(id,test_id,version,script,script_hash,timeout_ms,source_revision,workspace_settings,script_origin) ORDER BY id) FROM test_versions),'runs',(SELECT jsonb_agg(jsonb_build_array(id,test_id,version_id,script_snapshot,status,script_origin) ORDER BY id) FROM runs))::text`).Scan(&raw)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	before := snapshot()
	// A collision at 014 occurs after ALTER TABLE work in 011–013. The production
	// migrator must roll all pending migrations and ledger entries back together.
	if _, err = p.DB.ExecContext(ctx, `CREATE TABLE plans(synthetic_collision integer)`); err != nil {
		t.Fatal(err)
	}
	if err = p.Migrate(ctx); err == nil || !strings.Contains(err.Error(), "014_plans.sql") {
		t.Fatal("expected representative mid-upgrade failure", err)
	}
	var count int
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil || count != 10 {
		t.Fatal("partial migration ledger committed", count, err)
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tests' AND column_name='kind'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("partial ALTER committed", err)
	}
	if snapshot() != before {
		t.Fatal("failed upgrade changed M9 data")
	}
	if _, err = p.DB.ExecContext(ctx, `DROP TABLE plans`); err != nil {
		t.Fatal(err)
	}
	if err = p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil || count != 18 {
		t.Fatal("missing migration", count, err)
	}
	if snapshot() != before {
		t.Fatal("M9 data changed")
	}
	var defaults bool
	if err = p.DB.QueryRowContext(ctx, `SELECT (SELECT bool_and(kind='test' AND slug IS NULL) FROM tests) AND (SELECT bool_and(module IS NULL AND stages='[]'::jsonb AND context_revision=0 AND bundle_hash IS NULL AND summary_batch_hash IS NULL) FROM test_versions) AND (SELECT bool_and(author_partial IS NULL AND files_snapshot IS NULL AND bundle_hash IS NULL AND bundle_metadata IS NULL) FROM runs)`).Scan(&defaults); err != nil || !defaults {
		t.Fatal("legacy defaults invalid", err)
	}
	if _, err = p.Test(ctx, test); err != nil {
		t.Fatal("M10 cannot read M9 Test", err)
	}
	if item, err := p.Run(ctx, run); err != nil || item.Status != "queued" {
		t.Fatal("M10 cannot read M9 queued Run", err)
	}
	if err = p.RegisterManager(ctx, "m10-upgrade", 1); err != nil {
		t.Fatal(err)
	}
	assignment, err := p.Claim(ctx, "m10-upgrade", 1)
	if err != nil || assignment == nil || assignment.ID != run || len(assignment.Files) != 0 {
		t.Fatal("legacy script assignment broken", err)
	}
	if err = p.Migrate(ctx); err != nil {
		t.Fatal("idempotent rerun failed", err)
	}
	if err = p.DB.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil || count != 18 {
		t.Fatal("rerun changed ledger", err)
	}
	t.Log(fmt.Sprintf("M9 001–010 fixture -> injected 014 failure rolls 011–013 and ledger back -> M10 011–018 committed; 18 embedded migrations; legacy data/defaults/queued script assignment preserved; rerun idempotent"))
}
