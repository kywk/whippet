package server

import "net/http"

func (a *API) workspace(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	item, err := a.store.Workspace(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) patchWorkspace(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var patch WorkspacePatch
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := decodeBody(w, r, &patch); err != nil {
		a.fail(w, err)
		return
	}
	if patch.Revision < 1 {
		writeError(w, http.StatusBadRequest, "invalid_request", "positive revision is required")
		return
	}
	item, err := a.store.PatchWorkspace(r.Context(), id, patch)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}
