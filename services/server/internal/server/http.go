package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

type API struct {
	store         Store
	artifacts     ArtifactStorage
	engine        *Engine
	token         string
	adminToken    string
	publicOrigin  string
	adminSessions *adminSessions
	agentLimiter  *agentRateLimiter
	log           *slog.Logger
	liveViewer    http.Handler
	liveMedia     http.Handler
}

func NewAPI(store Store, artifacts ArtifactStorage, engine *Engine, token string, log *slog.Logger) *API {
	return &API{store: store, artifacts: artifacts, engine: engine, token: token, log: log, adminSessions: newAdminSessions(), agentLimiter: newAgentRateLimiter()}
}

// WithAdminAccess enables the M11 opt-in management boundary.
func (a *API) WithAdminAccess(token, publicOrigin string) *API {
	a.adminToken, a.publicOrigin = token, publicOrigin
	return a
}

// Configure once before serving; long-lived live sockets have their own lease.
func (a *API) WithLiveHandlers(viewer, media http.Handler) *API {
	a.liveViewer, a.liveMedia = viewer, media
	return a
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
	mux.Handle("/mcp", a.newMCPHandler())
	mux.HandleFunc("POST /api/dev-login", a.devLogin)
	mux.HandleFunc("POST /api/dev-logout", a.devLogout)
	mux.HandleFunc("GET /api/workspaces", a.workspaces)
	mux.HandleFunc("POST /api/workspaces", a.createWorkspace)
	mux.HandleFunc("POST /api/workspaces/{id}/agent-tokens", a.createAgentToken)
	mux.HandleFunc("GET /api/workspaces/{id}/agent-tokens", a.listAgentTokens)
	mux.HandleFunc("DELETE /api/workspaces/{id}/agent-tokens/{tokenId}", a.revokeAgentToken)
	mux.HandleFunc("GET /api/workspaces/{id}/agent-tool-audit", a.listAgentAudit)
	mux.HandleFunc("GET /api/workspaces/{id}/conversation", a.workspaceConversation)
	mux.HandleFunc("POST /api/workspaces/{id}/messages", a.workspaceMessage)
	mux.HandleFunc("GET /api/workspaces/{id}/proposals/{proposalId}", a.workspaceProposal)
	mux.HandleFunc("POST /api/workspaces/{id}/proposals/{proposalId}/{action}", a.workspaceProposalAction)
	mux.HandleFunc("PUT /api/workspaces/{id}/roles/{roleId}/credentials", a.workspaceCredentials)
	mux.HandleFunc("DELETE /api/workspaces/{id}/roles/{roleId}/credentials", a.workspaceCredentials)
	mux.HandleFunc("GET /api/workspaces/{id}", a.workspace)
	mux.HandleFunc("PATCH /api/workspaces/{id}/author-engine", a.patchAuthorEngine)
	mux.HandleFunc("PATCH /api/workspaces/{id}", a.patchWorkspace)
	mux.HandleFunc("GET /api/workspaces/{id}/tests", a.tests)
	mux.HandleFunc("POST /api/workspaces/{id}/tests", a.createTest)
	mux.HandleFunc("GET /api/tests/{id}", a.test)
	mux.HandleFunc("POST /api/tests/{id}/editing-session", a.startEditing)
	mux.HandleFunc("GET /api/tests/{id}/editing-session", a.editingSession)
	mux.HandleFunc("GET /api/tests/{id}/editing-sessions/{sessionId}", a.editingSession)
	mux.HandleFunc("POST /api/tests/{id}/editing-sessions/{sessionId}/discard", a.discardEditing)
	mux.HandleFunc("POST /api/tests/{id}/draft/summary", a.createSummary)
	mux.HandleFunc("GET /api/tests/{id}/draft", a.draft)
	mux.HandleFunc("PUT /api/tests/{id}/draft", a.saveDraft)
	mux.HandleFunc("POST /api/tests/{id}/draft/validate", a.validateDraft)
	mux.HandleFunc("POST /api/tests/{id}/publish", a.publish)
	mux.HandleFunc("GET /api/tests/{id}/versions", a.versions)
	mux.HandleFunc("GET /api/tests/{id}/conversation", a.conversation)
	mux.HandleFunc("GET /api/workspaces/{id}/catalog", a.catalog)
	mux.HandleFunc("GET /api/tests/{id}/plan", a.getPlan)
	mux.HandleFunc("PUT /api/tests/{id}/plan", a.putPlan)
	mux.HandleFunc("POST /api/plans/{id}/confirm", a.confirmPlan)
	mux.HandleFunc("GET /api/plans/{id}/stages/{stageId}/retry", a.stageRetry)
	mux.HandleFunc("POST /api/plans/{id}/stages/{stageId}/retry", a.stageRetry)
	mux.HandleFunc("POST /api/plans/{id}/cancel", a.cancelPlan)
	mux.HandleFunc("POST /api/plans/{id}/publish", a.publishPlan)
	mux.HandleFunc("POST /api/plans/{id}/summary", a.createPlanSummary)
	mux.HandleFunc("GET /api/plans/{id}/summary", a.getPlanSummary)
	mux.HandleFunc("POST /api/tests/{id}/messages", a.createAuthor)
	mux.HandleFunc("POST /api/tests/{id}/runs", a.createRun)
	mux.HandleFunc("GET /api/tests/{id}/runs", a.runs)
	mux.HandleFunc("GET /api/runs/{id}", a.run)
	mux.HandleFunc("GET /api/runs/{id}/artifacts", a.listArtifacts)
	mux.HandleFunc("POST /api/runs/{id}/cancel", a.cancel)
	mux.HandleFunc("POST /api/runs/{id}/continue", a.continueAuthor)
	mux.HandleFunc("POST /api/manager/runs/{id}/artifacts/{name...}", a.upload)
	mux.Handle("POST /api/manager/runs/{id}/attempts/{attemptId}/credentials/resolve", a.ManagerAuth(http.HandlerFunc(a.resolveCredentials)))
	mux.Handle("POST /api/manager/runs/{id}/attempts/{attemptId}/tools", a.ManagerAuth(http.HandlerFunc(a.harnessTool)))
	mux.Handle("POST /api/manager/runs/{id}/attempts/{attemptId}/history", a.ManagerAuth(http.HandlerFunc(a.conversationHistory)))
	mux.HandleFunc("GET /api/runs/{id}/artifacts/{name...}", a.artifact)
	if managerConnect != nil {
		mux.Handle("GET /api/manager/connect", a.ManagerAuth(managerConnect))
	}
	if a.liveViewer != nil {
		mux.Handle("GET /api/runs/{id}/live", a.liveViewer)
	}
	if a.liveMedia != nil {
		mux.Handle("GET /api/manager/runs/{id}/live", a.ManagerAuth(a.liveMedia))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { writeError(w, 404, "not_found", "route not found") })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		managerPath := strings.HasPrefix(r.URL.Path, "/api/manager/")
		if a.adminToken == "" && (r.URL.Path == "/mcp" || agentManagementPath(r.URL.Path)) {
			writeError(w, http.StatusServiceUnavailable, "disabled", "MCP is disabled")
			return
		}
		if a.adminToken != "" && strings.HasPrefix(r.URL.Path, "/api/") && !managerPath {
			if len(r.Header.Values("Authorization")) != 0 {
				writeError(w, http.StatusForbidden, "forbidden", "Bearer authentication is not accepted on management routes")
				return
			}
			if !a.adminRequestAllowed(r) {
				writeError(w, http.StatusUnauthorized, "unauthorized", "admin token required")
				return
			}
			if !a.adminRequestOriginAllowed(r) {
				writeError(w, http.StatusForbidden, "forbidden", "origin not allowed")
				return
			}
		}
		if err := authorizeDevelopment(r.Context()); err != nil {
			a.fail(w, err)
			return
		}
		// A bounded context protects database operations, without limiting a WS session.
		livePath := strings.HasSuffix(r.URL.Path, "/live") && (strings.HasPrefix(r.URL.Path, "/api/runs/") || strings.HasPrefix(r.URL.Path, "/api/manager/runs/"))
		if r.URL.Path != "/api/manager/connect" && !livePath {
			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			defer cancel()
			r = r.WithContext(ctx)
		}
		if !a.authorizeResource(w, r) {
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *API) adminHeaderValid(r *http.Request) bool {
	values := r.Header.Values("X-Whippet-Admin-Token")
	return len(values) == 1 && subtle.ConstantTimeCompare([]byte(values[0]), []byte(a.adminToken)) == 1
}

func (a *API) adminRequestAllowed(r *http.Request) bool {
	if r.URL.Path == "/api/dev-logout" {
		return true
	}
	if a.adminHeaderValid(r) {
		return true
	}
	if r.URL.Path == "/api/dev-login" {
		return false
	}
	return a.adminSessions.valid(adminCookie(r), time.Now())
}

func (a *API) adminRequestOriginAllowed(r *http.Request) bool {
	origins := r.Header.Values("Origin")
	if len(origins) > 0 && (len(origins) != 1 || a.publicOrigin == "" || origins[0] != a.publicOrigin) {
		return false
	}
	if r.URL.Path == "/api/dev-logout" {
		return len(origins) == 1 && origins[0] == a.publicOrigin
	}
	if r.URL.Path == "/api/dev-login" || a.adminHeaderValid(r) {
		return true
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		return len(origins) == 1 && origins[0] == a.publicOrigin
	}
	return true
}

func (a *API) devLogin(w http.ResponseWriter, r *http.Request) {
	if a.adminToken != "" {
		value, ok := a.adminSessions.issue(time.Now())
		if !ok {
			writeError(w, http.StatusServiceUnavailable, "session_capacity", "admin sessions unavailable")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: adminCookieName, Value: value, Path: "/api", HttpOnly: true, Secure: r.TLS != nil || strings.HasPrefix(a.publicOrigin, "https://"), SameSite: http.SameSiteStrictMode, MaxAge: int(adminSessionLifetime.Seconds())})
		w.Header().Set("Cache-Control", "no-store")
	}
	writeJSON(w, 200, map[string]any{"user": map[string]string{"id": "dev-admin", "role": "superadmin"}})
}

func (a *API) devLogout(w http.ResponseWriter, r *http.Request) {
	a.adminSessions.revoke(adminCookie(r))
	http.SetCookie(w, &http.Cookie{Name: adminCookieName, Path: "/api", MaxAge: -1, HttpOnly: true, Secure: r.TLS != nil || strings.HasPrefix(a.publicOrigin, "https://"), SameSite: http.SameSiteStrictMode})
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func agentManagementPath(path string) bool {
	return strings.HasSuffix(path, "/agent-tokens") || strings.Contains(path, "/agent-tokens/") || strings.HasSuffix(path, "/agent-tool-audit")
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
	if Terminal(item.Status) {
		a.engine.endLiveRun(item.ID)
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
	if name == "author.json" {
		if resolver, ok := a.store.(interface {
			AuthorArtifactLimit(context.Context, string, string) (int64, error)
		}); ok {
			var err error
			limit, err = resolver.AuthorArtifactLimit(r.Context(), id, attemptID)
			if err != nil {
				a.fail(w, err)
				return
			}
		}
	}
	if r.ContentLength > limit {
		writeError(w, 413, "artifact_too_large", fmt.Sprintf("artifact exceeds %d MiB", limit>>20))
		return
	}
	if err := a.store.UploadAllowed(r.Context(), id, attemptID, name); err != nil {
		a.fail(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	var item Artifact
	var err error
	if storage, ok := a.artifacts.(interface {
		saveWithLimit(string, string, string, io.Reader, int64) (Artifact, error)
	}); ok {
		item, err = storage.saveWithLimit(id, attemptID, name, r.Body, limit)
	} else {
		item, err = a.artifacts.Save(id, attemptID, name, r.Body)
	}
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

func (a *API) listArtifacts(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	items, err := a.store.ListArtifacts(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
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
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, path.Base(name)))
	w.Header().Set("Referrer-Policy", "no-referrer")
	if name == "report.html" {
		content, err := reportContent(f)
		if err != nil {
			a.fail(w, err)
			return
		}
		// Version the transformed representation to invalidate cached pre-shim reports.
		w.Header().Set("ETag", `"`+item.SHA256+`-storage-png-v1"`)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Opaque sandbox origin prevents scripts in a report from accessing the SPA.
		w.Header().Set("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
		http.ServeContent(w, r, name, time.Time{}, content)
		return
	} else if isScreenshotArtifact(name) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	} else if isEvidenceArtifact(name) {
		w.Header().Set("Content-Type", artifactContentType(name))
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, path.Base(name)))
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	} else {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	}
	http.ServeContent(w, r, name, info.ModTime(), f)
}

func (a *API) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrSkillUnavailable):
		writeError(w, 503, "skill_unavailable", "The configured skill package is unavailable or incompatible")
	case errors.Is(err, ErrHistoryUnavailable):
		writeError(w, 409, "history_unavailable", "Conversation history is unavailable for this attempt")
	case errors.Is(err, ErrScopeConfirmation):
		writeError(w, 409, "scope_confirmation_required", "Confirm the Workspace scope before this AI workflow can run")
	case errors.Is(err, ErrCredentialUnavailable):
		writeError(w, 409, "credential_unavailable", "The current attempt or confirmed role is no longer available")
	case errors.Is(err, ErrSecretsUnavailable):
		writeError(w, 503, "secrets_unavailable", "Workspace credential storage is unavailable")
	case errors.Is(err, ErrSecurityUnavailable):
		writeError(w, 503, "security_unavailable", "Settings can be saved; restricted exploration and execution are not ready")
	case errors.Is(err, ErrProposalRequired):
		w.Header().Set("Allow", "GET")
		writeError(w, 405, "proposal_required", "Workspace changes require a confirmed proposal")
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
