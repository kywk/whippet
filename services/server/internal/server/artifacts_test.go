package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArtifactStorageRejectsTraversalAndConflictingWritesUseDistinctKeys(t *testing.T) {
	root := t.TempDir()
	s, err := NewLocalArtifacts(root)
	if err != nil {
		t.Fatal(err)
	}
	run, attempt := NewID(), NewID()
	for _, name := range []string{"../report.html", "report.html/../../escape", "trace.zip", "/report.html"} {
		if _, err := s.Save(run, attempt, name, strings.NewReader("x")); !errors.Is(err, ErrInvalid) {
			t.Fatalf("unsafe name accepted: %q, %v", name, err)
		}
	}
	first, err := s.Save(run, attempt, "report.html", strings.NewReader("first"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Save(run, attempt, "report.html", strings.NewReader("second"))
	if err != nil {
		t.Fatal(err)
	}
	if first.StorageKey == second.StorageKey {
		t.Fatal("conflicting bodies must not overwrite the saved storage key")
	}
	f, err := s.Open(first.StorageKey)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	body, _ := io.ReadAll(f)
	if string(body) != "first" {
		t.Fatal("original report was overwritten")
	}
	if _, err := s.Open("../../etc/passwd"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("traversal accepted: %v", err)
	}
	linkedRun := NewID()
	if err := os.Symlink(t.TempDir(), filepath.Join(root, linkedRun)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(linkedRun, attempt, "report.html", strings.NewReader("escape")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("symlink escape accepted: %v", err)
	}
}

func TestManagerUploadRequiresTokenAndValidAttempt(t *testing.T) {
	store := newFlowStore()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler := NewAPI(store, files, NewEngine(store, log), "secret", log).Handler(nil)
	run, _ := store.CreateRun(context.Background(), store.testID)
	url := "/api/manager/runs/" + run.ID + "/artifacts/report.html"
	for _, tc := range []struct {
		token, attempt string
		status         int
	}{
		{"", NewID(), 401},
		{"Bearer wrong", NewID(), 401},
		{"Bearer secret", "../../escape", 400},
		{"Bearer secret", NewID(), 409},
	} {
		r := httptest.NewRequest("POST", url, strings.NewReader("report"))
		r.Header.Set("Authorization", tc.token)
		r.Header.Set("X-Attempt-Id", tc.attempt)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), `"error"`) {
			t.Fatalf("expected %d, got %d %s", tc.status, w.Code, w.Body)
		}
	}
}
