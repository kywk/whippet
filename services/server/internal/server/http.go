package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

type API struct {
	store     Store
	artifacts ArtifactStorage
	engine    *Engine
	token     string
	log       *slog.Logger
}

func NewAPI(store Store, artifacts ArtifactStorage, engine *Engine, token string, log *slog.Logger) *API {
	return &API{store, artifacts, engine, token, log}
}

// The MVP identity provider deliberately returns one development Superadmin.
// This is the shared authorization seam for future workspace membership checks.
func authorizeDevelopment(_ context.Context) error { return nil }

func (a *API) Handler(managerConnect http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := a.store.Ping(r.Context()); err != nil {
			writeError(w, 503, "not_ready", "database unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("POST /api/dev-login", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"user": map[string]string{"id": "dev-admin", "role": "superadmin"}})
	})
	mux.HandleFunc("GET /api/workspaces", a.workspaces)
	mux.HandleFunc("GET /api/workspaces/{id}/tests", a.tests)
	mux.HandleFunc("POST /api/workspaces/{id}/tests", a.createTest)
	mux.HandleFunc("GET /api/tests/{id}", a.test)
	mux.HandleFunc("GET /api/tests/{id}/draft", a.draft)
	mux.HandleFunc("PUT /api/tests/{id}/draft", a.saveDraft)
	mux.HandleFunc("POST /api/tests/{id}/draft/validate", a.validateDraft)
	mux.HandleFunc("POST /api/tests/{id}/publish", a.publish)
	mux.HandleFunc("GET /api/tests/{id}/versions", a.versions)
	mux.HandleFunc("GET /api/tests/{id}/conversation", a.conversation)
	mux.HandleFunc("POST /api/tests/{id}/messages", a.createAuthor)
	mux.HandleFunc("POST /api/tests/{id}/runs", a.createRun)
	mux.HandleFunc("GET /api/tests/{id}/runs", a.runs)
	mux.HandleFunc("GET /api/runs/{id}", a.run)
	mux.HandleFunc("POST /api/runs/{id}/cancel", a.cancel)
	mux.HandleFunc("POST /api/manager/runs/{id}/artifacts/{name}", a.upload)
	mux.HandleFunc("GET /api/runs/{id}/artifacts/{name}", a.artifact)
	if managerConnect != nil {
		mux.Handle("GET /api/manager/connect", a.ManagerAuth(managerConnect))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { writeError(w, 404, "not_found", "route not found") })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if err := authorizeDevelopment(r.Context()); err != nil {
			a.fail(w, err)
			return
		}
		// A bounded context protects database operations, without limiting a WS session.
		if r.URL.Path != "/api/manager/connect" {
			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			defer cancel()
			r = r.WithContext(ctx)
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *API) ManagerAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if a.token == "" || !strings.HasPrefix(header, "Bearer ") || subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(header, "Bearer ")), []byte(a.token)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, 401, "unauthorized", "valid Manager bearer token required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) id(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !ValidID(id) {
		writeError(w, 400, "invalid_request", "id must be a UUID")
		return "", false
	}
	return id, true
}

func (a *API) workspaces(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.Workspaces(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (a *API) tests(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	items, err := a.store.Tests(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (a *API) test(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	item, err := a.store.Test(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, item)
}

func (a *API) createRun(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	item, err := a.store.CreateRun(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, http.StatusAccepted, item)
}

func (a *API) runs(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	items, err := a.store.Runs(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (a *API) run(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	item, err := a.store.Run(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, item)
}

func (a *API) cancel(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	item, err := a.store.Cancel(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, 200, item)
}

func (a *API) upload(w http.ResponseWriter, r *http.Request) {
	a.ManagerAuth(http.HandlerFunc(a.uploadAuthorized)).ServeHTTP(w, r)
}

func (a *API) uploadAuthorized(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	attemptID, name := r.Header.Get("X-Attempt-Id"), r.PathValue("name")
	if !ValidID(attemptID) || !validArtifact(name) {
		writeError(w, 400, "invalid_request", "valid X-Attempt-Id and allowed artifact name required")
		return
	}
	limit := artifactLimit(name)
	if r.ContentLength > limit {
		writeError(w, 413, "artifact_too_large", fmt.Sprintf("artifact exceeds %d MiB", limit>>20))
		return
	}
	if err := a.store.UploadAllowed(r.Context(), id, attemptID, name); err != nil {
		a.fail(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	item, err := a.artifacts.Save(id, attemptID, name, r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, 413, "artifact_too_large", fmt.Sprintf("artifact exceeds %d MiB", limit>>20))
		} else {
			a.fail(w, err)
		}
		return
	}
	if err := a.store.SaveArtifact(r.Context(), item); err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"name": name, "size": item.Size})
}

func (a *API) artifact(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	name := r.PathValue("name")
	if !validArtifact(name) {
		writeError(w, 400, "invalid_request", "unsupported artifact name")
		return
	}
	item, err := a.store.Artifact(r.Context(), id, name)
	if err != nil {
		a.fail(w, err)
		return
	}
	f, err := a.artifacts.Open(item.StorageKey)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, 404, "not_found", "artifact file unavailable")
		} else {
			a.fail(w, err)
		}
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		a.fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", `"`+item.SHA256+`"`)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, name))
	w.Header().Set("Referrer-Policy", "no-referrer")
	if name == "report.html" {
		content, err := reportContent(f)
		if err != nil {
			a.fail(w, err)
			return
		}
		// Version the transformed representation to invalidate cached pre-shim reports.
		w.Header().Set("ETag", `"`+item.SHA256+`-storage-v1"`)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Opaque sandbox origin prevents scripts in a report from accessing the SPA.
		w.Header().Set("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
		http.ServeContent(w, r, name, time.Time{}, content)
		return
	} else {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	}
	http.ServeContent(w, r, name, info.ModTime(), f)
}

func (a *API) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		writeError(w, 404, "not_found", "resource not found")
	case errors.Is(err, ErrConflict):
		writeError(w, 409, "conflict", err.Error())
	case errors.Is(err, ErrInvalid):
		writeError(w, 400, "invalid_request", err.Error())
	default:
		a.log.Error("API request failed", "error", err)
		writeError(w, 500, "internal_error", "request failed")
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
