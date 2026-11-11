package server

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"path"
	"strings"
	"testing"
)

func evidenceName(body []byte, extension string) string {
	return fmt.Sprintf("data/%x.%s", sha1.Sum(body), extension)
}

func TestEvidenceNamesLimitsAndStorageValidation(t *testing.T) {
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	runID, attemptID := NewID(), NewID()
	// Transport fixture deliberately only has a ZIP signature: no unpacking or
	// full-archive parsing is part of this server contract.
	zip := []byte("PK\x03\x04synthetic trace")
	md := []byte("# 錯誤情境\n<script>untrusted</script>\n")
	for _, tc := range []struct {
		body  []byte
		ext   string
		limit int64
	}{{zip, "zip", 64 << 20}, {md, "md", 1 << 20}} {
		name := evidenceName(tc.body, tc.ext)
		if !validArtifact(name) || !artifactAllowed("run", name) || !artifactAllowed("validation", name) || artifactAllowed("author", name) || artifactAllowed("unknown", name) || artifactLimit(name) != tc.limit {
			t.Fatalf("evidence allowlist/limit: %s", name)
		}
		first, err := files.Save(runID, attemptID, name, bytes.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		retry, err := files.Save(runID, attemptID, name, bytes.NewReader(tc.body))
		if err != nil || retry.StorageKey != first.StorageKey || retry.SHA256 != first.SHA256 {
			t.Fatalf("identical upload did not preserve key/hash: %+v %v", retry, err)
		}
		if _, err := files.Save(runID, attemptID, name, strings.NewReader("conflicting content")); !errors.Is(err, ErrInvalid) {
			t.Fatalf("wrong filename hash accepted: %v", err)
		}
		f, err := files.Open(first.StorageKey)
		if err != nil {
			t.Fatal(err)
		}
		saved, err := io.ReadAll(f)
		f.Close()
		if err != nil || !bytes.Equal(saved, tc.body) {
			t.Fatal("saved evidence bytes changed")
		}
	}
	for _, name := range []string{"trace.zip", "error-context.md", "data/" + strings.Repeat("A", 40) + ".zip", "data/" + strings.Repeat("a", 39) + ".md", "data/" + strings.Repeat("a", 40) + ".ZIP", "data/" + strings.Repeat("a", 40) + ".html", "data/../trace.zip", "data/extra/" + strings.Repeat("a", 40) + ".md"} {
		if validArtifact(name) {
			t.Fatalf("unsupported evidence path accepted: %s", name)
		}
	}
	for _, tc := range []struct {
		body []byte
		ext  string
	}{{[]byte("not a ZIP"), "zip"}, {[]byte{0xff, 0xfe}, "md"}, {nil, "md"}} {
		if _, err := files.Save(runID, attemptID, evidenceName(tc.body, tc.ext), bytes.NewReader(tc.body)); !errors.Is(err, ErrInvalid) {
			t.Fatalf("bad evidence bytes accepted: %s %v", tc.ext, err)
		}
	}
	oversize := bytes.Repeat([]byte("m"), int(MaxMarkdownBytes+1))
	if _, err := files.Save(runID, attemptID, evidenceName(oversize, "md"), bytes.NewReader(oversize)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized Markdown accepted: %v", err)
	}
	if err := checkEvidenceQuota(31, MaxEvidenceTotalBytes-MaxArtifactBytes, MaxArtifactBytes); err != nil {
		t.Fatal("exact combined quota rejected")
	}
	for _, quota := range [][3]int64{{32, 0, 1}, {0, MaxEvidenceTotalBytes, 1}} {
		if err := checkEvidenceQuota(quota[0], quota[1], quota[2]); !errors.Is(err, ErrInvalid) {
			t.Fatal("combined ZIP/MD quota exceeded")
		}
	}
}

func TestEvidenceHTTPDownloadHeadersAndKind(t *testing.T) {
	ctx := context.Background()
	store := &screenshotStore{flowStore: newFlowStore(), kind: "validation"}
	run, _ := store.CreateRun(ctx, store.testID)
	assignment, err := store.Claim(ctx, "manager-test", 1)
	if err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(store, files, NewEngine(store, log), "token", log).Handler(nil)
	request := func(method, name string, body []byte, attempt string, length int64) *httptest.ResponseRecorder {
		prefix := "/api/runs/"
		if method == "POST" {
			prefix = "/api/manager/runs/"
		}
		r := httptest.NewRequest(method, prefix+run.ID+"/artifacts/"+name, bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer token")
		r.Header.Set("X-Attempt-Id", attempt)
		if length >= 0 {
			r.ContentLength = length
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		body             []byte
		ext, contentType string
	}{
		{[]byte("PK\x03\x04trace"), "zip", "application/zip"},
		{[]byte("# Failure\n<script>untrusted</script>"), "md", "text/markdown; charset=utf-8"},
	} {
		name := evidenceName(tc.body, tc.ext)
		if w := request("POST", name, tc.body, NewID(), -1); w.Code != 409 {
			t.Fatalf("stale attempt accepted: %d", w.Code)
		}
		for i := 0; i < 2; i++ {
			if w := request("POST", name, tc.body, assignment.AttemptID, -1); w.Code != 200 {
				t.Fatalf("upload/retry: %d %s", w.Code, w.Body)
			}
		}
		w := request("GET", name, nil, "", -1)
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), tc.body) || w.Header().Get("Content-Type") != tc.contentType ||
			w.Header().Get("Content-Disposition") != `attachment; filename="`+path.Base(name)+`"` ||
			w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Content-Security-Policy") != "sandbox; default-src 'none'" {
			t.Fatalf("unsafe evidence response: %d %+v", w.Code, w.Header())
		}
		if w := request("POST", name, tc.body, assignment.AttemptID, artifactLimit(name)+1); w.Code != 413 {
			t.Fatalf("declared oversize accepted: %d", w.Code)
		}
		store.kind = "author"
		for _, method := range []string{"POST", "GET"} {
			if w := request(method, name, tc.body, assignment.AttemptID, -1); w.Code != 400 {
				t.Fatalf("author %s accepted evidence: %d", method, w.Code)
			}
		}
		store.kind = "validation"
	}
}

type artifactListHTTPStore struct {
	Store
	runID string
	items []ArtifactInfo
}

func (s artifactListHTTPStore) ListArtifacts(_ context.Context, id string) ([]ArtifactInfo, error) {
	if id != s.runID {
		return nil, ErrNotFound
	}
	return s.items, nil
}

func TestArtifactsListHTTPEmptyAndUnknownRun(t *testing.T) {
	store := artifactListHTTPStore{runID: NewID(), items: []ArtifactInfo{}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(store, nil, NewEngine(store, log), "token", log).Handler(nil)
	for _, tc := range []struct {
		id     string
		status int
	}{{store.runID, 200}, {NewID(), 404}, {"invalid", 400}} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/runs/"+tc.id+"/artifacts", nil))
		if w.Code != tc.status {
			t.Fatalf("artifact list: expected %d got %d %s", tc.status, w.Code, w.Body)
		}
		if tc.status == 200 {
			var body struct {
				Items []ArtifactInfo `json:"items"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Items == nil || len(body.Items) != 0 {
				t.Fatalf("known Run without artifacts must return []: %s %v", w.Body, err)
			}
		}
	}
}
