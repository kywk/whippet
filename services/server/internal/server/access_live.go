package server

import (
	"context"
	"net/http"
	"time"
)

type viewerGrant struct {
	userID, cookie string
	workspaceGrant
	cancel context.CancelFunc
}

func (a *API) liveWorkspaceAPI(resource workspaceResource, operation workspaceAccess, next http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, release := a.registerViewer(w, r, resource, operation)
		if release == nil {
			return
		}
		defer release()
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

func (a *API) registerViewer(w http.ResponseWriter, r *http.Request, resource workspaceResource, operation workspaceAccess) (context.Context, func()) {
	ctx, finishCheck := context.WithTimeout(r.Context(), 5*time.Second)
	defer finishCheck()

	// Role edits, session revocation, and registering a viewer are serialized.
	// A handshake rechecks current grants before it can see a frame.
	a.viewerMu.Lock()
	defer a.viewerMu.Unlock()
	actor, session, ok := a.authenticatePlatform(w, r.WithContext(ctx), true)
	if !ok {
		return nil, nil
	}
	if actor.bootstrap && resource == workspaceByBrowserLease {
		a.fail(w, errForbidden)
		return nil, nil
	}
	grant, err := a.scopeWorkspace(r.WithContext(ctx), actor, resource, operation)
	if err != nil {
		a.fail(w, err)
		return nil, nil
	}
	if actor.bootstrap {
		return r.Context(), func() {}
	}
	viewerCtx, cancel := context.WithDeadline(r.Context(), session.expiresAt)
	cookie, _ := adminCookie(r)
	viewer := &viewerGrant{userID: actor.user.ID, cookie: cookie, workspaceGrant: grant, cancel: cancel}
	a.userViewers[viewer] = struct{}{}
	return viewerCtx, func() {
		cancel()
		a.viewerMu.Lock()
		delete(a.userViewers, viewer)
		a.viewerMu.Unlock()
	}
}

func (a *API) closeSessionViewersLocked(cookie string) {
	if cookie == "" {
		return
	}
	for viewer := range a.userViewers {
		if viewer.cookie == cookie {
			viewer.cancel()
			delete(a.userViewers, viewer)
		}
	}
}

func (a *API) recheckUserViewersLocked(user platformUser, workspaceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for viewer := range a.userViewers {
		if viewer.userID != user.ID || (workspaceID != "" && viewer.workspaceID != workspaceID) {
			continue
		}
		permissions, err := a.workspacePermissions(ctx, user, viewer.workspaceID)
		if err != nil || !permissions.allows(viewer.operation) {
			viewer.cancel()
			delete(a.userViewers, viewer)
		}
	}
}

func (a *API) recheckWorkspaceMemberViewersLocked(p *Postgres, member workspaceMember, workspaceID string) {
	var affected []*viewerGrant
	for viewer := range a.userViewers {
		if viewer.userID == member.ID && viewer.workspaceID == workspaceID {
			affected = append(affected, viewer)
		}
	}
	if len(affected) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	user, err := p.platformUser(ctx, member.ID)
	permissions := permissionsForWorkspace(user.Role, member.Role)
	for _, viewer := range affected {
		if err != nil || !permissions.allows(viewer.operation) {
			viewer.cancel()
			delete(a.userViewers, viewer)
		}
	}
}
