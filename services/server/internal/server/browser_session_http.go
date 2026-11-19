package server

import (
	"encoding/json"
	"io"
	"net/http"
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
