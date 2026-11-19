package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const requestTimeout = 30 * time.Second

type siteAccess int

const (
	signedIn siteAccess = iota
	createWorkspaces
	manageDirectory
)

type workspaceAccess int

const (
	useTests workspaceAccess = iota
	manageSettings
	manageMembers
	manageAgentTokens
)

func (p workspacePermissions) allows(operation workspaceAccess) bool {
	switch operation {
	case useTests:
		return p.ManageTests
	case manageSettings:
		return p.ManageSettings
	case manageMembers:
		return p.ManageMembers
	case manageAgentTokens:
		return p.ManageAgentTokens
	default:
		return false
	}
}

func (p sitePermissions) allows(access siteAccess) bool {
	switch access {
	case signedIn:
		return true
	case createWorkspaces:
		return p.CreateWorkspace
	case manageDirectory:
		return p.ManageUsers
	default:
		return false
	}
}

type workspaceResource string

const (
	workspaceByID           workspaceResource = "workspaces"
	workspaceByTest         workspaceResource = "tests"
	workspaceByPlan         workspaceResource = "plans"
	workspaceByRun          workspaceResource = "runs"
	workspaceByBrowserLease workspaceResource = "browser-lease"
)

type actorContextKey struct{}
type workspaceGrantKey struct{}

type workspaceGrant struct {
	workspaceID string
	operation   workspaceAccess
	permissions workspacePermissions
}

func actorFromContext(ctx context.Context) platformActor {
	actor, _ := ctx.Value(actorContextKey{}).(platformActor)
	return actor
}

func workspaceGrantFromContext(ctx context.Context) workspaceGrant {
	grant, _ := ctx.Value(workspaceGrantKey{}).(workspaceGrant)
	return grant
}

// Internal Harness calls use their own attempt/token authority. HTTP calls
// already have a grant and must resolve to the same Workspace in the store.
func authorizeWorkspace(ctx context.Context, id string) error {
	if grant, ok := ctx.Value(workspaceGrantKey{}).(workspaceGrant); ok && grant.workspaceID != id {
		return ErrNotFound
	}
	return nil
}

type platformUserLookup interface {
	platformUser(context.Context, string) (platformUser, error)
}

func (a *API) adminHeaderValid(r *http.Request) bool {
	values := r.Header.Values("X-Whippet-Admin-Token")
	return a.adminToken != "" && len(values) == 1 &&
		subtle.ConstantTimeCompare([]byte(values[0]), []byte(a.adminToken)) == 1
}

func (a *API) platformOriginAllowed(r *http.Request, required bool) bool {
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return !required
	}
	origin := a.publicOrigin
	if origin == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		origin = scheme + "://" + r.Host
	}
	return len(origins) == 1 && origins[0] == origin
}

func browserWrite(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}

func (a *API) authenticatePlatform(w http.ResponseWriter, r *http.Request, viewer bool) (platformActor, adminSession, bool) {
	w.Header().Set("Cache-Control", "no-store")
	if len(r.Header.Values("Authorization")) != 0 {
		writeError(w, http.StatusForbidden, "forbidden", "此 API 使用平台登入身分。")
		return platformActor{}, adminSession{}, false
	}
	cookie, presented := adminCookie(r)
	bootstrap := !presented && a.adminHeaderValid(r)
	session, valid := a.adminSessions.lookup(cookie, time.Now())
	if !valid && !bootstrap {
		writeError(w, http.StatusUnauthorized, "unauthorized", "請先登入 Whippet。")
		return platformActor{}, adminSession{}, false
	}
	if !a.platformOriginAllowed(r, viewer || !bootstrap && browserWrite(r.Method)) {
		writeError(w, http.StatusForbidden, "forbidden", "origin not allowed")
		return platformActor{}, adminSession{}, false
	}
	if bootstrap {
		user := presentUser(developmentAdmin, "Super Admin", superAdmin)
		return platformActor{user: user, bootstrap: true}, adminSession{}, true
	}
	users, ok := a.store.(platformUserLookup)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "users_unavailable", "使用者資料暫時無法使用。")
		return platformActor{}, adminSession{}, false
	}
	user, err := users.platformUser(r.Context(), session.userID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "請先登入 Whippet。")
		} else {
			a.fail(w, err)
		}
		return platformActor{}, adminSession{}, false
	}
	return platformActor{user: user}, session, true
}

func (a *API) siteAPI(access siteAccess, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, _, ok := a.authenticatePlatform(w, r, false)
		if !ok {
			return
		}
		if !actor.user.Permissions.allows(access) {
			a.fail(w, errForbidden)
			return
		}
		ctx := context.WithValue(r.Context(), actorContextKey{}, actor)
		next(w, r.WithContext(ctx))
	}
}

func (p *Postgres) ResourceWorkspace(ctx context.Context, kind, id string) (string, error) {
	workspace, _, err := p.resourceWorkspace(ctx, workspaceResource(kind), id)
	return workspace, err
}

func (p *Postgres) resourceWorkspace(ctx context.Context, resource workspaceResource, id string) (string, bool, error) {
	var query string
	switch resource {
	case workspaceByID:
		query = `SELECT id,false FROM workspaces WHERE id=$1`
	case workspaceByTest:
		query = `SELECT workspace_id,false FROM tests WHERE id=$1`
	case workspaceByPlan:
		query = `SELECT t.workspace_id,false FROM plans p JOIN tests t ON t.id=p.test_id WHERE p.id=$1`
	case workspaceByRun:
		query = `SELECT workspace_id,test_id IS NULL FROM runs WHERE id=$1`
	default:
		return "", false, ErrNotFound
	}
	var workspaceID string
	var isSettingsRun bool
	err := p.DB.QueryRowContext(ctx, query, id).Scan(&workspaceID, &isSettingsRun)
	return workspaceID, isSettingsRun, dbError(err)
}

func (a *API) scopeWorkspace(r *http.Request, actor platformActor, resource workspaceResource, operation workspaceAccess) (workspaceGrant, error) {
	ctx := r.Context()
	id := r.PathValue("id")
	if resource == workspaceByBrowserLease {
		id = r.PathValue("sessionId")
	}
	if !ValidID(id) {
		return workspaceGrant{}, ErrInvalid
	}
	workspaceID, isSettingsRun, err := a.workspaceOwner(r, resource, id)
	if err != nil {
		return workspaceGrant{}, err
	}
	if isSettingsRun {
		operation = manageSettings
	}
	if expected := r.URL.Query().Get("workspaceId"); expected != "" && expected != workspaceID {
		return workspaceGrant{}, ErrNotFound
	}
	permissions, err := a.workspacePermissions(ctx, actor.user, workspaceID)
	if err != nil {
		return workspaceGrant{}, err
	}
	if !permissions.ManageTests {
		return workspaceGrant{}, ErrNotFound
	}
	if !permissions.allows(operation) {
		return workspaceGrant{}, errForbidden
	}
	return workspaceGrant{workspaceID, operation, permissions}, nil
}

func (a *API) workspaceOwner(r *http.Request, resource workspaceResource, id string) (string, bool, error) {
	if p, ok := a.store.(*Postgres); ok {
		if resource == workspaceByBrowserLease {
			target, err := p.BrowserSessionLiveTarget(r.Context(), id, r.PathValue("leaseId"))
			return target.WorkspaceID, false, err
		}
		return p.resourceWorkspace(r.Context(), resource, id)
	}
	if owner, ok := a.store.(interface {
		ResourceWorkspace(context.Context, string, string) (string, error)
	}); ok {
		workspaceID, err := owner.ResourceWorkspace(r.Context(), string(resource), id)
		return workspaceID, false, err
	}
	if resource == workspaceByID {
		return id, false, nil
	}
	return "", false, nil
}

func (a *API) workspacePermissions(ctx context.Context, user platformUser, workspaceID string) (workspacePermissions, error) {
	if user.Role.admin() {
		return permissionsForWorkspace(user.Role, noMemberRole), nil
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		return workspacePermissions{}, errForbidden
	}
	member, err := readMemberRole(ctx, p.DB, workspaceID, user.ID)
	return permissionsForWorkspace(user.Role, member), err
}

func (a *API) workspaceAPI(resource workspaceResource, operation workspaceAccess, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, _, ok := a.authenticatePlatform(w, r, false)
		if !ok {
			return
		}
		grant, err := a.scopeWorkspace(r, actor, resource, operation)
		if err != nil {
			a.fail(w, err)
			return
		}
		ctx := context.WithValue(r.Context(), actorContextKey{}, actor)
		ctx = context.WithValue(ctx, workspaceGrantKey{}, grant)
		next(w, r.WithContext(ctx))
		if a.engine != nil && resource == workspaceByID && operation == manageSettings && browserWrite(r.Method) &&
			(r.Method == http.MethodPatch || r.PathValue("roleId") != "" || r.PathValue("proposalId") != "") {
			a.engine.refreshLive(ctx)
		}
	}
}

func (a *API) mcpFeature(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.adminToken == "" {
			writeError(w, http.StatusServiceUnavailable, "disabled", "MCP is disabled")
			return
		}
		next(w, r)
	}
}

func decodeAccessBody(w http.ResponseWriter, r *http.Request, dst any, allowEmpty bool) error {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil {
		return ErrInvalid
	}
	if allowEmpty && len(raw) == 0 {
		return io.EOF
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' || strictJSONNoDuplicates(raw) != nil {
		return ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(dst) != nil || decoder.Decode(new(any)) != io.EOF {
		return ErrInvalid
	}
	return nil
}

func (a *API) devLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !a.platformOriginAllowed(r, false) || len(r.Header.Values("Authorization")) != 0 {
		a.fail(w, errForbidden)
		return
	}
	if a.adminToken != "" && !a.adminHeaderValid(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "請輸入管理 key。")
		return
	}
	var body struct {
		UserID string `json:"userId"`
	}
	switch err := decodeAccessBody(w, r, &body, true); err {
	case io.EOF:
		body.UserID = developmentAdmin
	case nil:
		if body.UserID == "" {
			a.fail(w, ErrInvalid)
			return
		}
	default:
		a.fail(w, err)
		return
	}
	users, ok := a.store.(platformUserLookup)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "users_unavailable", "使用者資料暫時無法使用。")
		return
	}
	user, err := users.platformUser(r.Context(), body.UserID)
	if err != nil {
		a.fail(w, err)
		return
	}
	cookie, _ := adminCookie(r)
	a.viewerMu.Lock()
	value, ok := a.adminSessions.issue(time.Now(), user.ID, cookie)
	if ok {
		a.closeSessionViewersLocked(cookie)
	}
	a.viewerMu.Unlock()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "session_capacity", "登入工作階段已滿，請稍後再試。")
		return
	}
	a.setAdminCookie(w, r, value, int(adminSessionLifetime.Seconds()))
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (a *API) setAdminCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: adminCookieName, Value: value, Path: "/api", MaxAge: maxAge,
		HttpOnly: true, Secure: r.TLS != nil || strings.HasPrefix(a.publicOrigin, "https://"), SameSite: http.SameSiteStrictMode})
}

func (a *API) devLogout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !a.platformOriginAllowed(r, true) || len(r.Header.Values("Authorization")) != 0 {
		a.fail(w, errForbidden)
		return
	}
	cookie, _ := adminCookie(r)
	a.viewerMu.Lock()
	a.adminSessions.revoke(cookie)
	a.closeSessionViewersLocked(cookie)
	a.viewerMu.Unlock()
	a.setAdminCookie(w, r, "", -1)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"user": actorFromContext(r.Context()).user})
}

func (a *API) users(w http.ResponseWriter, r *http.Request) {
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	users, err := readPlatformUsers(r.Context(), p.DB, false)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": users})
}

func (a *API) updateUserRole(w http.ResponseWriter, r *http.Request) {
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	var body struct {
		Role siteRole `json:"role"`
	}
	if err := decodeAccessBody(w, r, &body, false); err != nil {
		a.fail(w, err)
		return
	}
	ctx, id := r.Context(), r.PathValue("userId")
	a.viewerMu.Lock()
	user, err := p.setSiteRole(ctx, actorFromContext(ctx), id, body.Role)
	if err == nil {
		a.recheckUserViewersLocked(user, "")
	}
	a.viewerMu.Unlock()
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (a *API) workspaceMembers(w http.ResponseWriter, r *http.Request) {
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	members, err := p.workspaceMembers(r.Context(), workspaceGrantFromContext(r.Context()).workspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": members})
}

func (a *API) updateWorkspaceMember(w http.ResponseWriter, r *http.Request) {
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	var body struct {
		Role memberRole `json:"role"`
	}
	if err := decodeAccessBody(w, r, &body, false); err != nil {
		a.fail(w, err)
		return
	}
	ctx := r.Context()
	id := workspaceGrantFromContext(ctx).workspaceID
	a.viewerMu.Lock()
	member, err := p.setWorkspaceMember(ctx, actorFromContext(ctx), id, r.PathValue("userId"), body.Role)
	if err == nil {
		a.recheckWorkspaceMemberViewersLocked(p, member, id)
	}
	a.viewerMu.Unlock()
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"member": member})
}
