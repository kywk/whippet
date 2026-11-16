package server

import (
	"context"
	"net/http"
	"strconv"
)

func (a *API) listAgentAudit(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	workspace, ok := a.id(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	for key, values := range query {
		if (key != "limit" && key != "before") || len(values) != 1 {
			a.fail(w, ErrInvalid)
			return
		}
	}
	limit := 20
	if raw := query.Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			a.fail(w, ErrInvalid)
			return
		}
	}
	before := query.Get("before")
	if len(before) > 256 {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(interface {
		AgentToolAudits(context.Context, string, int, string) ([]AgentToolAudit, *string, error)
	})
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	items, next, err := store.AgentToolAudits(r.Context(), workspace, limit, before)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "nextCursor": next})
}
