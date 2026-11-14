package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func (a *API) listBrowserSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if a.adminToken == "" {
		writeError(w, http.StatusServiceUnavailable, "disabled", "MCP is disabled")
		return
	}
	workspace, ok := a.id(w, r)
	if !ok {
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok || a.engine == nil {
		a.fail(w, ErrConflict)
		return
	}
	manager, epoch, ready := a.engine.BrowserEndpoint()
	if !ready {
		if _, err := p.Workspace(r.Context(), workspace); err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": []BrowserSessionItem{}})
		return
	}
	items, err := p.BrowserSessions(r.Context(), workspace, manager, epoch)
	if err != nil {
		a.fail(w, err)
		return
	}
	// The Manager may have reconnected while the database query was running.
	currentManager, currentEpoch, current := a.engine.BrowserEndpoint()
	if !current || currentManager != manager || currentEpoch != epoch {
		items = []BrowserSessionItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) resolveBrowserSessionCredentials(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if a.adminToken == "" {
		writeError(w, http.StatusServiceUnavailable, "disabled", "MCP is disabled")
		return
	}
	if r.TLS == nil {
		writeError(w, http.StatusBadRequest, "protected_transport_required", "Manager credential resolution requires TLS")
		return
	}
	sessionID, leaseID := r.PathValue("sessionId"), r.PathValue("leaseId")
	if !ValidID(sessionID) || !ValidID(leaseID) {
		a.fail(w, ErrInvalid)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2048))
	if err != nil {
		a.fail(w, ErrInvalid)
		return
	}
	fields, err := strictBrowserPayload(raw, "roleId")
	if err != nil {
		a.fail(w, ErrInvalid)
		return
	}
	var roleID string
	if json.Unmarshal(fields["roleId"], &roleID) != nil || !ValidID(roleID) {
		a.fail(w, ErrInvalid)
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok || a.engine == nil {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	manager, epoch, ready := a.engine.BrowserEndpoint()
	if !ready {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	value, err := p.ResolveBrowserSessionCredentials(r.Context(), manager, epoch, sessionID, leaseID, roleID)
	if err != nil {
		a.fail(w, err)
		return
	}
	currentManager, currentEpoch, current := a.engine.BrowserEndpoint()
	if !current || currentManager != manager || currentEpoch != epoch {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (a *API) sessionViewerAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		origins := r.Header.Values("Origin")
		if a.adminToken == "" || a.publicOrigin == "" || !a.adminSessions.valid(adminCookie(r), time.Now()) ||
			len(origins) != 1 || origins[0] != a.publicOrigin || len(r.Header.Values("Authorization")) != 0 {
			writeError(w, http.StatusForbidden, "forbidden", "valid same-origin management session required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Keep the long-lived WebSocket out of the normal 30-second API context.
func sessionLivePath(path string) bool {
	return (strings.HasPrefix(path, "/api/browser-sessions/") || strings.HasPrefix(path, "/api/manager/browser-sessions/")) && strings.HasSuffix(path, "/live")
}
