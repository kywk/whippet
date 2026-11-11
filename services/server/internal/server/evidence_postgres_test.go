//go:build integration

package server

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestPostgresEvidenceArtifacts(t *testing.T) {
	// Explicit TEST_DATABASE_URL and a random, disposable schema, shared with
	// the M5 test helper. Never fall back to the running service database.
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	const testID = "10000000-0000-4000-8000-000000000001"
	run, err := p.CreateRun(ctx, testID)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.RegisterManager(ctx, "evidence-test", 1); err != nil {
		t.Fatal(err)
	}
	a, err := p.Claim(ctx, "evidence-test", 1)
	if err != nil || a == nil || a.ID != run.ID {
		t.Fatalf("claim: %+v %v", a, err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	for _, tc := range []struct {
		body []byte
		ext  string
	}{{[]byte("PK\x03\x04trace"), "zip"}, {[]byte("# 錯誤情境"), "md"}} {
		name := evidenceName(tc.body, tc.ext)
		item, err := files.Save(run.ID, a.AttemptID, name, bytes.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 2; i++ {
			if err := p.SaveArtifact(ctx, item); err != nil {
				t.Fatalf("artifact save/retry: %v", err)
			}
		}
		item.SHA256 = "conflicting-content"
		if err := p.SaveArtifact(ctx, item); !errors.Is(err, ErrConflict) {
			t.Fatalf("immutable artifact overwritten: %v", err)
		}
		item.AttemptID = NewID()
		if err := p.SaveArtifact(ctx, item); !errors.Is(err, ErrConflict) {
			t.Fatalf("wrong attempt accepted: %v", err)
		}
	}
	items, err := p.ListArtifacts(ctx, run.ID)
	if err != nil || len(items) != 2 || items[0].Name >= items[1].Name {
		t.Fatalf("current attempt list/sort: %+v %v", items, err)
	}
	for _, item := range items {
		if item.URL != "/api/runs/"+run.ID+"/artifacts/"+item.Name || item.ContentType != artifactContentType(item.Name) || item.Size <= 0 {
			t.Fatalf("incorrect public metadata: %+v", item)
		}
		if _, err := p.Artifact(ctx, run.ID, item.Name); err != nil {
			t.Fatalf("listed artifact cannot be retrieved: %v", err)
		}
	}
	empty, err := p.CreateRun(ctx, testID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DB.ExecContext(ctx, `INSERT INTO artifacts(run_id,name,attempt_id,storage_key,size_bytes,sha256)
	    VALUES($1,$2,$3,'not-a-public-path',1,'stale')`, empty.ID, items[0].Name, NewID()); err != nil {
		t.Fatal(err)
	}
	if list, err := p.ListArtifacts(ctx, empty.ID); err != nil || list == nil || len(list) != 0 {
		t.Fatalf("another attempt leaked into list: %+v %v", list, err)
	}
	if _, err := p.Artifact(ctx, empty.ID, items[0].Name); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale attempt downloadable: %v", err)
	}
	if _, err := p.ListArtifacts(ctx, NewID()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown Run should be 404: %v", err)
	}
	if _, err := p.DB.ExecContext(ctx, `INSERT INTO artifacts(run_id,name,attempt_id,storage_key,size_bytes,sha256)
	    VALUES($1,'data/arbitrary.exe',$2,'fixture',1,'fixture')`, empty.ID, NewID()); err == nil {
		t.Fatal("migration allows arbitrary artifact suffix/path")
	}
	// Metadata-only quota fixtures avoid writing 128 MiB just to exercise the
	// transaction/count boundary; byte validation above uses the real storage.
	reset := func() {
		t.Helper()
		if _, err := p.DB.ExecContext(ctx, `DELETE FROM artifacts WHERE run_id=$1`, run.ID); err != nil {
			t.Fatal(err)
		}
	}
	metadata := func(index int, ext string, size int64) Artifact {
		return Artifact{RunID: run.ID, AttemptID: a.AttemptID, Name: fmt.Sprintf("data/%040x.%s", index, ext), StorageKey: "quota-fixture", Size: size, SHA256: "quota-fixture"}
	}
	save := func(item Artifact) {
		t.Helper()
		if err := p.SaveArtifact(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	reset()
	first := metadata(1, "zip", MaxArtifactBytes)
	save(first)
	save(metadata(2, "zip", MaxArtifactBytes))
	save(first) // Retry at exact combined byte quota does not count twice.
	if err := p.SaveArtifact(ctx, metadata(3, "md", 1)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("combined byte quota exceeded: %v", err)
	}
	save(metadata(1, "png", 1)) // ZIP quota must not consume PNG bytes/count.
	reset()
	for i := 0; i < MaxEvidenceCount; i++ {
		save(metadata(i, "md", 1))
	}
	save(metadata(0, "md", 1)) // Retry at exact count quota is idempotent.
	if err := p.SaveArtifact(ctx, metadata(100, "zip", 4)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("combined file quota exceeded: %v", err)
	}
	save(metadata(1, "png", 1))
	reset()
	for i := 0; i < MaxScreenshotCount; i++ {
		save(metadata(i, "png", 1))
	}
	save(metadata(1, "zip", 4)) // Full PNG count must not consume ZIP/MD quota.
	if err := p.Complete(ctx, "evidence-test", run.ID, a.AttemptID, Result{Status: "succeeded"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("optional artifacts replaced required reports: %v", err)
	}
	if err := p.Complete(ctx, "evidence-test", run.ID, a.AttemptID, Result{Status: "failed", Error: "assertion failed"}); err != nil {
		t.Fatal(err)
	}
	failed, err := p.Run(ctx, run.ID)
	if err != nil || failed.Status != "failed" || !strings.Contains(failed.Error, "assertion failed") {
		t.Fatalf("evidence changed failure result: %+v %v", failed, err)
	}
}
