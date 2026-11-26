package server

import (
	"net/http"
	"net/url"
	"strconv"
)

const managementJSONLimit = 16 << 10

func (a *API) listManagedWorkspaces(w http.ResponseWriter, r *http.Request) {
	state, after, limit, err := managedWorkspaceFilter(r.URL.RawQuery)
	if err != nil {
		a.fail(w, err)
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	ctx := r.Context()
	items, next, err := p.managedWorkspaceList(ctx, actorFromContext(ctx).user.Role, state, after, limit)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "nextAfter": next})
}

func managedWorkspaceFilter(raw string) (state, after string, limit int, err error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return "", "", 0, ErrInvalid
	}
	state, limit = "all", 50
	for key, value := range values {
		if len(value) != 1 {
			return "", "", 0, ErrInvalid
		}
		switch key {
		case "state":
			state = value[0]
			switch state {
			case "all", "active", "archiving", "archived":
			default:
				return "", "", 0, ErrInvalid
			}
		case "after":
			after = value[0]
			if !ValidID(after) {
				return "", "", 0, ErrInvalid
			}
		case "limit":
			limit, err = strconv.Atoi(value[0])
			if err != nil || limit < 1 || limit > 100 {
				return "", "", 0, ErrInvalid
			}
		default:
			return "", "", 0, ErrInvalid
		}
	}
	return state, after, limit, nil
}

func (a *API) managedWorkspace(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	ctx := r.Context()
	item, err := readManagedWorkspace(ctx, p.DB, id, actorFromContext(ctx).user.Role)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) renameWorkspaceHTTP(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	var body struct {
		Revision int    `json:"revision"`
		Name     string `json:"name"`
	}
	ctx := r.Context()
	actor := actorFromContext(ctx)
	if err := decodeManagementBody(w, r, &body, managementJSONLimit, false); err != nil {
		a.failManagement(w, r, actor, err)
		return
	}
	item, err := p.renameManagedWorkspace(ctx, actor, id, body.Revision, body.Name)
	if err != nil {
		a.failManagement(w, r, actor, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) archiveWorkspaceHTTP(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	var body struct {
		Revision int    `json:"revision"`
		Mode     string `json:"mode"`
	}
	ctx := r.Context()
	actor := actorFromContext(ctx)
	if err := decodeManagementBody(w, r, &body, managementJSONLimit, false); err != nil {
		a.failManagement(w, r, actor, err)
		return
	}
	item, err := p.archiveWorkspace(ctx, actor, id, body.Revision, body.Mode)
	if err != nil {
		a.failManagement(w, r, actor, err)
		return
	}
	if a.engine != nil {
		a.engine.Wake()
	}
	status := http.StatusOK
	if item.Workspace.Management.State == workspaceArchiving {
		status = http.StatusAccepted
	}
	writeJSON(w, status, item)
}

func (a *API) restoreWorkspaceHTTP(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	var body struct {
		Revision int `json:"revision"`
	}
	ctx := r.Context()
	actor := actorFromContext(ctx)
	if err := decodeManagementBody(w, r, &body, managementJSONLimit, false); err != nil {
		a.failManagement(w, r, actor, err)
		return
	}
	item, err := p.restoreWorkspace(ctx, actor, id, body.Revision)
	if err != nil {
		a.failManagement(w, r, actor, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}
