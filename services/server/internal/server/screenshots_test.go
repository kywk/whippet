package server

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"io"
	"log/slog"
	"net/http/httptest"
	"net/url"
	"path"
	"strings"
	"testing"
)

func TestScreenshotAllowlistAndQuotas(t *testing.T) {
	valid := "data/" + strings.Repeat("a", 40) + ".png"
	if !validArtifact(valid) || !artifactAllowed("run", valid) || !artifactAllowed("validation", valid) || artifactAllowed("author", valid) {
		t.Fatal("PNG kind allowlist mismatch")
	}
	for _, invalid := range []string{
		"data/" + strings.Repeat("A", 40) + ".png",
		"data/" + strings.Repeat("a", 64) + ".png",
		"data/" + strings.Repeat("a", 39) + ".png",
		valid + ".html", "data/../report.html", "../" + valid,
		"data/extra/" + strings.Repeat("a", 40) + ".png", "data/escape.svg",
	} {
		if validArtifact(invalid) {
			t.Fatalf("unsafe screenshot name accepted: %q", invalid)
		}
	}
	if artifactLimit(valid) != 10<<20 {
		t.Fatal("PNG limit must be 10 MiB")
	}
	if err := checkScreenshotQuota(31, MaxScreenshotTotalBytes-MaxScreenshotBytes, MaxScreenshotBytes); err != nil {
		t.Fatalf("32nd screenshot at exact limits rejected: %v", err)
	}
	for _, limits := range [][3]int64{{32, 0, 1}, {0, MaxScreenshotTotalBytes, 1}, {0, 0, MaxScreenshotBytes + 1}} {
		if err := checkScreenshotQuota(limits[0], limits[1], limits[2]); !errors.Is(err, ErrInvalid) {
			t.Fatalf("PNG quota exceeded: %v", limits)
		}
	}
}

type screenshotStore struct {
	*flowStore
	kind string
}

func (s *screenshotStore) UploadAllowed(ctx context.Context, runID, attemptID, name string) error {
	if !artifactAllowed(s.kind, name) {
		return ErrInvalid
	}
	return s.flowStore.UploadAllowed(ctx, runID, attemptID, name)
}

func (s *screenshotStore) Artifact(ctx context.Context, runID, name string) (Artifact, error) {
	if !artifactAllowed(s.kind, name) {
		return Artifact{}, ErrInvalid
	}
	return s.flowStore.Artifact(ctx, runID, name)
}

func TestScreenshotHTTPRelativeReportAndSandbox(t *testing.T) {
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
	request := func(method, target string, body []byte, length int64) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer token")
		r.Header.Set("X-Attempt-Id", assignment.AttemptID)
		if length >= 0 {
			r.ContentLength = length
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	name := "data/" + strings.Repeat("a", 40) + ".png"
	uploadPath := "/api/manager/runs/" + run.ID + "/artifacts/" + name
	if w := request("POST", uploadPath, encoded.Bytes(), -1); w.Code != 200 {
		t.Fatalf("PNG upload: %d %s", w.Code, w.Body)
	}
	report := []byte(`<!doctype html><html><head></head><body><img src="` + name + `"></body></html>`)
	if w := request("POST", "/api/manager/runs/"+run.ID+"/artifacts/report.html", report, -1); w.Code != 200 {
		t.Fatalf("report upload: %d %s", w.Code, w.Body)
	}
	reportURL, _ := url.Parse("/api/runs/" + run.ID + "/artifacts/report.html")
	relative, _ := url.Parse(name)
	w := request("GET", reportURL.ResolveReference(relative).String(), nil, -1)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("X-Content-Type-Options") != "nosniff" || !bytes.Equal(w.Body.Bytes(), encoded.Bytes()) {
		t.Fatalf("relative PNG download: %d %s", w.Code, w.Body)
	}
	a, err := store.Artifact(ctx, run.ID, name)
	if err != nil {
		t.Fatal(err)
	}
	if path.Base(a.StorageKey) != path.Base(name) {
		t.Fatal("native screenshot name was not retained")
	}
	w = request("GET", reportURL.String(), nil, -1)
	csp := w.Header().Get("Content-Security-Policy")
	if w.Code != 200 || !strings.Contains(csp, "img-src 'self' data: blob:") ||
		!strings.Contains(csp, "connect-src 'none'") || !strings.Contains(csp, "script-src 'unsafe-inline';") ||
		strings.Contains(csp, "allow-same-origin") || !strings.Contains(w.Body.String(), "data-whippet-storage-shim") ||
		!strings.Contains(w.Body.String(), `src="`+name+`"`) {
		t.Fatal("report isolation, storage shim or relative screenshot path changed")
	}
	if w := request("POST", uploadPath, []byte("<svg>not PNG</svg>"), -1); w.Code != 400 {
		t.Fatalf("non-PNG accepted: %d", w.Code)
	}
	if w := request("POST", uploadPath, encoded.Bytes(), MaxScreenshotBytes+1); w.Code != 413 {
		t.Fatalf("oversized PNG accepted: %d", w.Code)
	}
	store.kind = "author"
	if w := request("POST", uploadPath, encoded.Bytes(), -1); w.Code != 400 {
		t.Fatalf("author PNG upload accepted: %d", w.Code)
	}
	if w := request("GET", reportURL.ResolveReference(relative).String(), nil, -1); w.Code != 400 {
		t.Fatalf("author PNG read accepted: %d", w.Code)
	}
}
