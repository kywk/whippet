package server

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPublicationRequiresCurrentValidatedRevisionAndReport(t *testing.T) {
	id := NewID()
	base := draftState{Draft: Draft{TestID: NewID(), Revision: 2, Script: "test('current', () => {});", ValidationRunID: &id}, timeoutMS: 60000}
	base.hash = scriptHash(base.Script)
	base.WorkspaceSettings = &WorkspaceSettings{Revision: 1, Sites: []WorkspaceSite{}, TimeoutMS: 60000}
	proof := validationEvidence{id: id, testID: base.TestID, kind: "validation", status: "succeeded", revision: 2,
		script: base.Script, hash: base.hash, timeoutMS: 60000, reportReady: true}
	proof.settings = base.WorkspaceSettings
	if err := checkPublication(2, true, base, proof); err != nil {
		t.Fatalf("current successful revision with saved report must publish: %v", err)
	}
	cases := []struct {
		name   string
		change func(*draftState, *validationEvidence)
	}{
		{"missing_validation", func(d *draftState, _ *validationEvidence) { d.ValidationRunID = nil }},
		{"old_revision_success", func(_ *draftState, v *validationEvidence) { v.revision = 1 }},
		{"wrong_validation", func(_ *draftState, v *validationEvidence) { v.id = NewID() }},
		{"other_test", func(_ *draftState, v *validationEvidence) { v.testID = NewID() }},
		{"published_run_is_not_validation", func(_ *draftState, v *validationEvidence) { v.kind = "run" }},
		{"old_script", func(_ *draftState, v *validationEvidence) { v.script = "old" }},
		{"wrong_hash", func(_ *draftState, v *validationEvidence) { v.hash = "old" }},
		{"changed_settings", func(_ *draftState, v *validationEvidence) { v.timeoutMS++ }},
		{"missing_settings", func(_ *draftState, v *validationEvidence) { v.settings = nil }},
		{"changed_url_same_timeout", func(_ *draftState, v *validationEvidence) {
			settings := *v.settings
			settings.DefaultTestURL = "https://other.example.test/"
			v.settings = &settings
		}},
		{"changed_sites_same_timeout", func(_ *draftState, v *validationEvidence) {
			settings := *v.settings
			settings.Sites = []WorkspaceSite{{Name: "other", URL: "https://other.example.test/"}}
			v.settings = &settings
		}},
		{"changed_settings_revision", func(_ *draftState, v *validationEvidence) {
			settings := *v.settings
			settings.Revision++
			v.settings = &settings
		}},
		{"failed_validation", func(_ *draftState, v *validationEvidence) { v.status = "failed" }},
		{"queued_validation", func(_ *draftState, v *validationEvidence) { v.status = "queued" }},
		{"cancelled_validation", func(_ *draftState, v *validationEvidence) { v.status = "cancelled" }},
		{"missing_report", func(_ *draftState, v *validationEvidence) { v.reportReady = false }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, v := base, proof
			tc.change(&d, &v)
			if err := checkPublication(2, true, d, v); !errors.Is(err, ErrConflict) {
				t.Fatalf("unsafe publication accepted: %v", err)
			}
		})
	}
	if err := checkPublication(1, true, base, proof); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale UI revision accepted: %v", err)
	}
	if err := checkPublication(2, false, base, proof); !errors.Is(err, ErrInvalid) {
		t.Fatalf("publication without user confirmation accepted: %v", err)
	}
}

func TestPublicationReportMustExistOnDisk(t *testing.T) {
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, err := files.Save(NewID(), NewID(), "report.html", strings.NewReader("<html>real report</html>"))
	if err != nil {
		t.Fatal(err)
	}
	p := &Postgres{Artifacts: files}
	key := sql.NullString{String: a.StorageKey, Valid: true}
	size := sql.NullInt64{Int64: a.Size, Valid: true}
	if !p.reportReady(key, size) {
		t.Fatal("saved readable report rejected")
	}
	if p.reportReady(sql.NullString{}, size) || p.reportReady(key, sql.NullInt64{}) ||
		p.reportReady(key, sql.NullInt64{Valid: true}) ||
		p.reportReady(key, sql.NullInt64{Int64: a.Size + 1, Valid: true}) ||
		p.reportReady(sql.NullString{String: "missing-report", Valid: true}, size) {
		t.Fatal("metadata without a matching non-empty physical report accepted")
	}
}

type draftHTTPStore struct{ Store }

func (draftHTTPStore) SaveDraft(context.Context, string, string, int, string) (Draft, error) {
	return Draft{}, ErrConflict
}

func TestDraftHTTPRejectsStaleAndInvalidRequests(t *testing.T) {
	store := draftHTTPStore{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewAPI(store, nil, NewEngine(store, log), "test", log).Handler(nil)
	for _, tc := range []struct {
		method, suffix, body string
		status               int
	}{
		{"PUT", "/draft", `{"editingSessionId":"00000000-0000-4000-8000-000000000001","revision":1,"script":"changed"}`, 409},
		{"PUT", "/draft", `{"revision":1}`, 400},
		{"PUT", "/draft", `{"revision":0,"script":"changed"}`, 400},
		{"PUT", "/draft", `{"revision":1,"script":"x"} {}`, 400},
		{"POST", "/publish", `{"revision":1,"confirmed":false}`, 400},
		{"POST", "/publish", `{"revision":1}`, 400},
		{"POST", "/draft/validate", `{"revision":0}`, 400},
	} {
		r := httptest.NewRequest(tc.method, "/api/tests/"+NewID()+tc.suffix, strings.NewReader(tc.body))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), `"error"`) {
			t.Fatalf("%s %s: expected %d, got %d %s", tc.method, tc.suffix, tc.status, w.Code, w.Body)
		}
	}
}
