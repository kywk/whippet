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
	"sync"
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
	viewerMu      sync.Mutex
	userViewers   map[*viewerGrant]struct{}
	agentLimiter  *agentRateLimiter
	inspections   *InspectionConfig
	log           *slog.Logger
	liveViewer    http.Handler
	liveMedia     http.Handler
	sessionViewer http.Handler
	sessionMedia  http.Handler
}

func NewAPI(store Store, artifacts ArtifactStorage, engine *Engine, token string, log *slog.Logger) *API {
	return &API{
		store: store, artifacts: artifacts, engine: engine, token: token, log: log,
		adminSessions: newAdminSessions(), userViewers: make(map[*viewerGrant]struct{}), agentLimiter: newAgentRateLimiter(),
	}
}

// WithAdminAccess configures the shared development key and public browser origin.
func (a *API) WithAdminAccess(token, publicOrigin string) *API {
	a.adminToken, a.publicOrigin = token, publicOrigin
	return a
}

// Configure once before serving; long-lived live sockets have their own lease.
func (a *API) WithLiveHandlers(viewer, media http.Handler) *API {
	a.liveViewer, a.liveMedia = viewer, media
	return a
}

func (a *API) WithSessionLiveHandlers(viewer, media http.Handler) *API {
	a.sessionViewer, a.sessionMedia = viewer, media
	return a
}

func (a *API) WithInspectionConfig(config *InspectionConfig) *API {
	a.inspections = config
	return a
}

func (a *API) Handler(managerConnect http.Handler) http.Handler {
	mux := http.NewServeMux()
	handle := func(pattern string, next http.HandlerFunc) { mux.Handle(pattern, boundedRequest(next)) }
	site := func(pattern string, permission siteAccess, next http.HandlerFunc) {
		handle(pattern, a.siteAPI(permission, next))
	}
	workspace := func(pattern string, permission workspaceAccess, next http.HandlerFunc) {
		handle(pattern, a.workspaceAPI(workspaceByID, permission, next))
	}
	test := func(pattern string, next http.HandlerFunc) {
		handle(pattern, a.workspaceAPI(workspaceByTest, useTests, next))
	}
	plan := func(pattern string, next http.HandlerFunc) {
		handle(pattern, a.workspaceAPI(workspaceByPlan, useTests, next))
	}
	run := func(pattern string, next http.HandlerFunc) {
		handle(pattern, a.workspaceAPI(workspaceByRun, useTests, next))
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	handle("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := a.store.Ping(r.Context()); err != nil {
			writeError(w, 503, "not_ready", "database unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	mux.Handle("/mcp", boundedRequest(a.newMCPHandler()))
	if a.inspections != nil {
		handle("GET /api/inspections/workspaces/{workspaceId}/runs", a.inspectionHTTP)
		handle("POST /api/inspections/workspaces/{workspaceId}/runs", a.inspectionHTTP)
		handle("GET /api/inspections/workspaces/{workspaceId}/runs/{runId}", a.inspectionHTTP)
		handle("POST /api/inspections/workspaces/{workspaceId}/runs/{runId}/links", a.inspectionHTTP)
		handle("POST /api/retests/workspaces/{workspaceId}/runs", a.retestHTTP)
		handle("GET /api/retests/workspaces/{workspaceId}/runs/{runId}", a.retestHTTP)
	}
	handle("POST /api/dev-login", a.devLogin)
	handle("POST /api/dev-logout", a.devLogout)
	site("GET /api/me", signedIn, a.me)
	site("GET /api/users", manageDirectory, a.users)
	site("PATCH /api/users/{userId}/role", manageSiteRoles, a.updateUserRole)
	site("GET /api/admin/workspaces", manageSiteWorkspaces, a.listManagedWorkspaces)
	site("GET /api/admin/workspaces/{id}", manageSiteWorkspaces, a.managedWorkspace)
	site("PATCH /api/admin/workspaces/{id}", manageSiteWorkspaces, a.renameWorkspaceHTTP)
	site("POST /api/admin/workspaces/{id}/archive", manageSiteWorkspaces, a.archiveWorkspaceHTTP)
	site("POST /api/admin/workspaces/{id}/restore", manageSiteWorkspaces, a.restoreWorkspaceHTTP)
	site("/api/admin/ai/{path...}", manageAIResources, func(w http.ResponseWriter, _ *http.Request) {
		a.fail(w, ErrNotFound)
	})
	site("GET /api/workspaces", signedIn, a.workspaces)
	site("POST /api/workspaces", createWorkspaces, a.createWorkspace)
	workspace("POST /api/workspaces/{id}/agent-tokens", manageAgentTokens, a.mcpFeature(a.createAgentToken))
	workspace("GET /api/workspaces/{id}/agent-tokens", manageAgentTokens, a.mcpFeature(a.listAgentTokens))
	workspace("DELETE /api/workspaces/{id}/agent-tokens/{tokenId}", manageAgentTokens, a.mcpFeature(a.revokeAgentToken))
	workspace("GET /api/workspaces/{id}/agent-tool-audit", manageAgentTokens, a.mcpFeature(a.listAgentAudit))
	handle("GET /api/workspaces/{id}/browser-sessions", a.mcpFeature(a.workspaceAPI(workspaceByID, manageSettings, a.listBrowserSessions)))
	workspace("GET /api/workspaces/{id}/conversation", manageSettings, a.workspaceConversation)
	workspace("POST /api/workspaces/{id}/messages", manageSettings, a.workspaceMessage)
	workspace("GET /api/workspaces/{id}/proposals/{proposalId}", manageSettings, a.workspaceProposal)
	workspace("POST /api/workspaces/{id}/proposals/{proposalId}/{action}", manageSettings, a.workspaceProposalAction)
	workspace("PUT /api/workspaces/{id}/roles/{roleId}/credentials", manageSettings, a.workspaceCredentials)
	workspace("DELETE /api/workspaces/{id}/roles/{roleId}/credentials", manageSettings, a.workspaceCredentials)
	workspace("GET /api/workspaces/{id}", useTests, a.workspace)
	workspace("PATCH /api/workspaces/{id}/author-engine", manageSettings, a.patchAuthorEngine)
	workspace("GET /api/workspaces/{id}/agent-runtime", manageSettings, a.agentRuntime)
	workspace("PATCH /api/workspaces/{id}/agent-runtime", manageSettings, a.agentRuntime)
	workspace("PATCH /api/workspaces/{id}", manageSettings, a.patchWorkspace)
	workspace("GET /api/workspaces/{id}/members", manageMembers, a.workspaceMembers)
	workspace("PUT /api/workspaces/{id}/members/{userId}", manageMembers, a.updateWorkspaceMember)
	workspace("GET /api/workspaces/{id}/tests", useTests, a.tests)
	workspace("GET /api/workspaces/{id}/run-activity", useTests, a.runActivity)
	workspace("GET /api/workspaces/{id}/archived-tests", useTests, a.archivedTests)
	workspace("POST /api/workspaces/{id}/tests", useTests, a.createTest)
	test("GET /api/tests/{id}", a.test)
	test("POST /api/tests/{id}/archive", a.archiveTest)
	test("PATCH /api/tests/{id}/metadata", a.patchTestMetadata)
	test("POST /api/tests/{id}/editing-session", a.startEditing)
	test("GET /api/tests/{id}/editing-session", a.editingSession)
	test("GET /api/tests/{id}/editing-sessions/{sessionId}", a.editingSession)
	test("POST /api/tests/{id}/editing-sessions/{sessionId}/discard", a.discardEditing)
	test("POST /api/tests/{id}/editing-sessions/{sessionId}/replace-with-new-test", a.replaceDraftWithNewTest)
	test("POST /api/tests/{id}/editing-sessions/{sessionId}/similar-test", a.decideSimilarTest)
	test("POST /api/tests/{id}/draft/summary", a.createSummary)
	test("GET /api/tests/{id}/draft", a.draft)
	test("PUT /api/tests/{id}/draft", a.saveDraft)
	test("POST /api/tests/{id}/draft/validate", a.validateDraft)
	test("POST /api/tests/{id}/publish", a.publish)
	test("GET /api/tests/{id}/versions", a.versions)
	test("GET /api/tests/{id}/versions/{versionId}/conversation", a.versionConversation)
	test("GET /api/tests/{id}/conversation", a.conversation)
	workspace("GET /api/workspaces/{id}/catalog", useTests, a.catalog)
	test("GET /api/tests/{id}/plan", a.getPlan)
	test("PUT /api/tests/{id}/plan", a.putPlan)
	plan("POST /api/plans/{id}/confirm", a.confirmPlan)
	plan("POST /api/plans/{id}/stages/{stageId}/split", a.splitPlanStage)
	plan("GET /api/plans/{id}/stages/{stageId}/retry", a.stageRetry)
	plan("POST /api/plans/{id}/stages/{stageId}/retry", a.stageRetry)
	plan("POST /api/plans/{id}/stages/{stageId}/continue", a.continuePlanStage)
	plan("POST /api/plans/{id}/cancel", a.cancelPlan)
	plan("POST /api/plans/{id}/publish", a.publishPlan)
	plan("POST /api/plans/{id}/summary", a.createPlanSummary)
	plan("GET /api/plans/{id}/summary", a.getPlanSummary)
	test("POST /api/tests/{id}/messages", a.createAuthor)
	test("POST /api/tests/{id}/runs", a.createRun)
	test("GET /api/tests/{id}/runs", a.runs)
	run("GET /api/runs/{id}", a.run)
	run("GET /api/runs/{id}/artifacts", a.listArtifacts)
	run("POST /api/runs/{id}/cancel", a.cancel)
	run("POST /api/runs/{id}/continue", a.continueAuthor)
	run("GET /api/runs/{id}/artifacts/{name...}", a.artifact)
	handle("GET /api/runs/{id}/report-view/{reportGrant}/{name...}", a.reportView)
	handle("POST /api/manager/runs/{id}/artifacts/{name...}", a.upload)
	mux.Handle("POST /api/manager/runs/{id}/attempts/{attemptId}/credentials/resolve", boundedRequest(a.ManagerAuth(http.HandlerFunc(a.resolveCredentials))))
	mux.Handle("POST /api/manager/browser-sessions/{sessionId}/leases/{leaseId}/credentials/resolve", boundedRequest(a.ManagerAuth(http.HandlerFunc(a.resolveBrowserSessionCredentials))))
	mux.Handle("POST /api/manager/runs/{id}/attempts/{attemptId}/tools", boundedRequest(a.ManagerAuth(http.HandlerFunc(a.harnessTool))))
	mux.Handle("POST /api/manager/runs/{id}/attempts/{attemptId}/history", boundedRequest(a.ManagerAuth(http.HandlerFunc(a.conversationHistory))))
	if managerConnect != nil {
		mux.Handle("GET /api/manager/connect", a.ManagerAuth(managerConnect))
	}
	if a.liveViewer != nil {
		mux.HandleFunc("GET /api/runs/{id}/live", a.liveWorkspaceAPI(workspaceByRun, useTests, a.liveViewer))
	}
	if a.liveMedia != nil {
		mux.Handle("GET /api/manager/runs/{id}/live", a.ManagerAuth(a.liveMedia))
	}
	if a.sessionViewer != nil {
		mux.HandleFunc("GET /api/browser-sessions/{sessionId}/leases/{leaseId}/live", a.mcpFeature(a.liveWorkspaceAPI(workspaceByBrowserLease, manageSettings, a.sessionViewer)))
	}
	if a.sessionMedia != nil {
		mux.Handle("GET /api/manager/browser-sessions/{sessionId}/leases/{leaseId}/live", a.ManagerAuth(a.sessionMedia))
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { writeError(w, 404, "not_found", "route not found") })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
}

func boundedRequest(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
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
	ctx := r.Context()
	user := actorFromContext(ctx).user
	var items []Workspace
	var err error
	if user.Role.admin() {
		items, err = a.store.Workspaces(ctx)
		if err == nil {
			permissions := permissionsForWorkspace(user.Role, noMemberRole)
			for i := range items {
				items[i] = presentWorkspace(items[i], permissions)
			}
		}
	} else if p, ok := a.store.(*Postgres); ok {
		items, err = p.memberWorkspaces(ctx, user.ID)
	} else {
		err = errForbidden
	}
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
		a.failManagement(w, r, actorFromContext(r.Context()), err)
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
	if name == "report.html" && a.redirectReport(w, r, id) {
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
	case errors.Is(err, ErrContinuationBudget):
		writeError(w, 409, "continuation_budget_exhausted", "此續接鏈已達總嘗試上限，或剩餘模型、工具及執行時間額度不足，無法再繼續；已保存的草稿與證據仍保留。")
	case errors.Is(err, ErrContinuationUsage):
		writeError(w, 409, "continuation_usage_unavailable", "此任務缺少可信的續接總額或用量紀錄，無法安全續接；請先檢視已保存的草稿與證據。")
	case errors.Is(err, ErrSkillUnavailable):
		writeError(w, 503, "skill_unavailable", "The configured skill package is unavailable or incompatible")
	case errors.Is(err, ErrHistoryUnavailable):
		writeError(w, 409, "history_unavailable", "Conversation history is unavailable for this attempt")
	case errors.Is(err, ErrScopeConfirmation):
		writeError(w, 409, "scope_confirmation_required", "請先確認 Workspace 的網站範圍。")
	case errors.Is(err, ErrAuthorOffTopic):
		writeError(w, 422, "author_off_topic", "這裡只處理 Playwright 測試、執行結果與測試相關的 Workspace 設定。請描述你要驗證的行為。")
	case errors.Is(err, ErrAuthorClarification):
		writeError(w, 422, "author_clarification_required", "請補充要測試的頁面、操作或預期結果，或說明你想釐清的測試問題。")
	case errors.Is(err, ErrAuthorPolicy):
		writeError(w, 503, "author_policy_unavailable", "測試對話的意圖檢查暫時無法使用，請稍後再試。")
	case errors.Is(err, ErrSimilarTestDecision):
		writeError(w, 409, "similar_test_decision_required", "請先確認要調整既有腳本，或繼續新增。")
	case errors.Is(err, ErrCredentialUnavailable):
		writeError(w, 409, "credential_unavailable", "The current attempt or confirmed role is no longer available")
	case errors.Is(err, ErrSecretsUnavailable):
		writeError(w, 503, "secrets_unavailable", "Workspace credential storage is unavailable")
	case errors.Is(err, ErrSecurityUnavailable):
		writeError(w, 503, "security_unavailable", "Settings can be saved; restricted exploration and execution are not ready")
	case errors.Is(err, ErrProposalRequired):
		w.Header().Set("Allow", "GET")
		writeError(w, 405, "proposal_required", "Workspace changes require a confirmed proposal")
	case errors.Is(err, errForbidden):
		writeError(w, 403, "forbidden", err.Error())
	case errors.Is(err, errLastSuper):
		writeError(w, 409, "last_super_admin", "至少需要保留一位 Super Admin。")
	case errors.Is(err, errManagementRevision):
		writeError(w, 409, "stale_revision", "工作區管理資料已更新，請重新載入。")
	case errors.Is(err, errWorkspaceArchiving):
		writeError(w, 409, "workspace_archiving", "工作區封存中，暫停接受新工作。")
	case errors.Is(err, errWorkspaceArchived):
		writeError(w, 409, "workspace_archived", "工作區已封存。")
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
