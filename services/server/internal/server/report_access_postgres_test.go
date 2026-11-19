//go:build integration

package server

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type reportAccessFixture struct {
	api                 *API
	run, workspace, png string
	pngBytes            []byte
}

func newReportAccessFixture(t *testing.T) reportAccessFixture {
	t.Helper()
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	manualSeedVersions(t, p, ctx)
	const testID = "10000000-0000-4000-8000-000000000001"
	run, err := p.CreateRun(ctx, testID)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.RegisterManager(ctx, "report-fixture", 1); err != nil {
		t.Fatal(err)
	}
	assignment, err := p.Claim(ctx, "report-fixture", 1)
	if err != nil || assignment == nil || assignment.ID != run.ID {
		t.Fatal("report fixture dispatch unavailable", err)
	}
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8g4AAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("data/%x.png", sha1.Sum(png))
	report := []byte(`<!doctype html><html><head><title>Report</title></head><body><img alt="Evidence" src="` + name + `"></body></html>`)
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for fileName, content := range map[string][]byte{"report.html": report, name: png} {
		item, err := files.Save(run.ID, assignment.AttemptID, fileName, bytes.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := NewAPI(p, files, nil, "fixture-manager", log).WithAdminAccess(fixtureAdminKey, "")
	return reportAccessFixture{api: api, run: run.ID, workspace: run.WorkspaceID, png: name, pngBytes: png}
}

func TestReportAttachmentGrantPostgres(t *testing.T) {
	f := newReportAccessFixture(t)
	handler := f.api.Handler(nil)
	call := func(method, path, body, key string, cookie *http.Cookie, status int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(body))
		r.Header.Set("Origin", fixtureOrigin)
		if key != "" {
			r.Header.Set("X-Whippet-Admin-Token", key)
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("got %d want %d", w.Code, status)
		}
		return w
	}
	qa := call("POST", "/api/dev-login", `{"userId":"dev-qa"}`, fixtureAdminKey, nil, 200).Result().Cookies()[0]
	site := call("POST", "/api/dev-login", `{"userId":"dev-site-admin"}`, fixtureAdminKey, nil, 200).Result().Cookies()[0]
	prefix := "/api/runs/" + f.run
	canonical := prefix + "/artifacts/report.html"
	call("HEAD", canonical, "", "", qa, 200)
	call("GET", canonical, "", fixtureAdminKey, nil, 200)
	location := call("GET", canonical, "", "", qa, 307).Header().Get("Location")
	if !strings.HasPrefix(location, prefix+"/report-view/") {
		t.Fatal("signed-in report did not redirect to attachment scope")
	}
	scoped := strings.TrimSuffix(location, "report.html")
	call("GET", location, "", "", nil, 401)
	page := call("GET", location, "", "", qa, 200)
	if !strings.Contains(page.Body.String(), f.png) || !strings.Contains(page.Header().Get("Content-Security-Policy"), "sandbox allow-scripts;") {
		t.Fatal("report reference or sandbox changed")
	}
	item := call("GET", scoped+f.png, "", "", nil, 200)
	if !bytes.Equal(item.Body.Bytes(), f.pngBytes) || item.Header().Get("Cache-Control") != "no-store" || item.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("signed screenshot differs or can be cached/referred")
	}
	call("GET", scoped+f.png, "", "", site, 401)
	call("GET", scoped+"results.json", "", "", nil, 404)
	call("GET", strings.Replace(scoped+f.png, f.run, NewID(), 1), "", "", nil, 401)
	call("GET", prefix+"/artifacts/"+f.png, "", "", nil, 401)
	proof, ok := f.api.adminSessions.reportGrant(qa.Value, f.run, time.Now().Add(-reportGrantLifetime-time.Second))
	if !ok {
		t.Fatal("could not generate expired test grant")
	}
	expired := prefix + "/report-view/" + proof + "/"
	call("GET", expired+f.png, "", "", nil, 401)
	if got := call("GET", expired+"report.html", "", "", qa, 307).Header().Get("Location"); got != canonical {
		t.Fatal("expired report cannot refresh its attachment proof")
	}
	memberPath := "/api/workspaces/" + f.workspace + "/members/dev-qa"
	call("PUT", memberPath, `{"role":"none"}`, "", site, 200)
	call("GET", scoped+f.png, "", "", nil, 404)
	call("GET", location, "", "", qa, 404)
	call("PUT", memberPath, `{"role":"qa"}`, "", site, 200)
	call("POST", "/api/dev-logout", "", "", qa, 204)
	call("GET", scoped+f.png, "", "", nil, 401)
}
