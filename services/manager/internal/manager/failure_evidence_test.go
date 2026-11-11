package manager

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Basic signature/transport fixtures only, never claimed to be real traces.
var evidenceZIPFixture = []byte{'P', 'K', 3, 4, 1, 2, 3, 4}

func writeEvidence(t *testing.T, taskDir, ext string, body []byte) string {
	t.Helper()
	name := "data/" + hex.EncodeToString(sha1Sum(body)) + "." + ext
	if err := os.MkdirAll(filepath.Join(taskDir, "output/data"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "output", filepath.FromSlash(name)), body, 0600); err != nil {
		t.Fatal(err)
	}
	return name
}
func sha1Sum(body []byte) []byte { hash := sha1.Sum(body); return hash[:] }

func TestM6EvidenceValidatesContentAndSkipsUnsafeOptionalFiles(t *testing.T) {
	dir := t.TempDir()
	zip := writeEvidence(t, dir, "zip", evidenceZIPFixture)
	md := writeEvidence(t, dir, "md", []byte("# Synthetic assertion context\n"))
	badZIP := writeEvidence(t, dir, "zip", []byte{'P', 'K', 7, 8})
	badMD := writeEvidence(t, dir, "md", []byte{0xff})
	for _, name := range []string{badZIP, badMD, "data/" + strings.Repeat("A", 40) + ".zip", "data/../report.html"} {
		if file, err := openArtifact(dir, name); err == nil {
			file.Close()
			t.Fatal("unsafe optional evidence accepted")
		}
	}
	link := writeEvidence(t, dir, "zip", append(append([]byte{}, evidenceZIPFixture...), 9))
	path := filepath.Join(dir, "output", filepath.FromSlash(link))
	os.Remove(path)
	os.Symlink(filepath.Join(dir, "output", filepath.FromSlash(zip)), path)
	for ext, limit := range map[string]int64{"md": maxEvidenceMDBytes, "zip": maxEvidenceZIPBytes} {
		name := writeEvidence(t, dir, ext, []byte("oversize "+ext))
		file, err := os.OpenFile(filepath.Join(dir, "output", filepath.FromSlash(name)), os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(limit + 1); err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
	got := collectFailureEvidence(dir)
	if len(got) != 2 || !(got[0] == zip || got[1] == zip) || !(got[0] == md || got[1] == md) {
		t.Fatalf("unexpected optional list: %v", got)
	}
	for _, name := range got {
		if artifactAllowed(record{Kind: "author"}, name) {
			t.Fatal("author accepted ordinary failure evidence")
		}
	}
	output := filepath.Join(dir, "output")
	atomicJSON(filepath.Join(output, "result.json"), Result{Status: "failed", Error: "original assertion failed"})
	result, _ := collectResult(dir, execution{ExitCode: 1})
	if result.Status != "failed" || result.Error != "original assertion failed" {
		t.Fatal("invalid optional evidence changed assertion result")
	}
	atomicJSON(filepath.Join(output, "result.json"), Result{Status: "succeeded"})
	result, _ = collectResult(dir, execution{ExitCode: 0})
	if result.Status != "failed" {
		t.Fatal("optional evidence substituted for missing required reports")
	}
}

func TestM6EvidenceQuotaIsIndependentAndRevalidatedOnRecovery(t *testing.T) {
	dir := t.TempDir()
	var names []string
	for i := 0; i < 33; i++ {
		names = append(names, writeEvidence(t, dir, "md", []byte(strings.Repeat("x", i+1))))
	}
	writeScreenshot(t, dir, 1)
	if got := collectFailureEvidence(dir); len(got) != 32 {
		t.Fatal("optional 32-file cap not enforced independently")
	}
	if got := filterFailureEvidence(dir, names); len(got) != 32 {
		t.Fatal("recovery did not revalidate optional count")
	}
	// Two sparse 64MiB ZIP fixtures exactly fill the byte quota. Hash using a
	// stream, not a 128MiB allocation; the following Markdown must be excluded.
	largeDir := t.TempDir()
	var largeNames []string
	for _, marker := range []byte{1, 2} {
		if err := os.MkdirAll(filepath.Join(largeDir, "output/data"), 0700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(largeDir, "output/data/.sparse")
		file, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		file.Write([]byte{'P', 'K', 3, 4, marker})
		file.Truncate(maxEvidenceZIPBytes)
		file.Seek(0, io.SeekStart)
		hash := sha1.New()
		if _, err := io.Copy(hash, file); err != nil {
			t.Fatal(err)
		}
		file.Close()
		name := "data/" + hex.EncodeToString(hash.Sum(nil)) + ".zip"
		if err := os.Rename(path, filepath.Join(largeDir, "output", filepath.FromSlash(name))); err != nil {
			t.Fatal(err)
		}
		largeNames = append(largeNames, name)
	}
	largeNames = append(largeNames, writeEvidence(t, largeDir, "md", []byte("overflow")))
	if got := filterFailureEvidence(largeDir, largeNames); len(got) != 2 {
		t.Fatal("recovery did not enforce combined 128MiB quota")
	}
}

func TestM6OnlyOptionalHTTP413IsSkippable(t *testing.T) {
	m, _, ctx := lifecycleManager(t, 1)
	r := record{RunID: newID(), AttemptID: newID(), Kind: "run"}
	zip := writeEvidence(t, m.taskDir(r), "zip", evidenceZIPFixture)
	png := writeScreenshot(t, m.taskDir(r), 1)
	os.WriteFile(filepath.Join(m.taskDir(r), "output/report.html"), []byte("fixture report"), 0600)
	for _, status := range []int{400, 401, 409, 413, 500} {
		m.http.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
		})
		for _, name := range []string{zip, png, "report.html"} {
			var skipped *skippedEvidenceError
			err := m.upload(ctx, r, name)
			if errors.As(err, &skipped) != (name == zip && status == 413) {
				t.Fatalf("incorrect skip for %s status %d", name, status)
			}
		}
	}
	m.http.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("synthetic network failure") })
	var skipped *skippedEvidenceError
	if errors.As(m.upload(ctx, r, zip), &skipped) {
		t.Fatal("network error was swallowed")
	}
}

func TestM6RecoveredOptional413CompletesJournalWithoutRerunning(t *testing.T) {
	m, d, ctx := lifecycleManager(t, 1)
	r := record{RunID: newID(), AttemptID: newID(), Kind: "run", Phase: "collecting", Reclaimed: true, ResultMessageID: newID(), Result: &Result{Status: "failed", Error: "original assertion failed"}}
	zip := writeEvidence(t, m.taskDir(r), "zip", evidenceZIPFixture)
	md := writeEvidence(t, m.taskDir(r), "md", []byte("# Context"))
	out := filepath.Join(m.taskDir(r), "output")
	os.WriteFile(filepath.Join(out, "report.html"), []byte("fixture report"), 0600)
	atomicJSON(filepath.Join(out, "results.json"), map[string]any{"errors": []string{"original assertion failed"}})
	r.Artifacts = []string{zip, md, "report.html", "results.json"}
	if err := m.store(r); err != nil {
		t.Fatal(err)
	}
	var uploads []string
	m.http.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		name := strings.Split(req.URL.Path, "/artifacts/")[1]
		uploads = append(uploads, name)
		body, _ := io.ReadAll(req.Body)
		status := 201
		if name == zip {
			status = 413
			if req.Header.Get("Content-Type") != "application/zip" || !bytes.Equal(body, evidenceZIPFixture) {
				t.Error("ZIP upload changed body or MIME")
			}
		}
		if name == md && req.Header.Get("Content-Type") != "text/markdown; charset=utf-8" {
			t.Error("MD MIME mismatch")
		}
		if journalRecord(m, r.AttemptID).Phase == "complete" {
			t.Error("result completed before evidence/reports")
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})
	m.runAttempt(ctx, ctx, r, nil)
	loaded, err := loadRecords(m.cfg.WorkDir)
	if err != nil {
		t.Fatal(err)
	}
	saved := loaded[r.AttemptID]
	if saved.Phase != "complete" || saved.Result.Status != "failed" || saved.Result.Error != "original assertion failed" {
		t.Fatal("recovery changed result or stalled on optional413")
	}
	if len(saved.Artifacts) != 3 || saved.Artifacts[0] != md || len(uploads) != 4 || uploads[0] != zip || uploads[1] != md || uploads[2] != "report.html" {
		t.Fatal("optional skip not persisted or upload order changed")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.tasks) != 0 {
		t.Fatal("recovery reran Worker")
	}
}
