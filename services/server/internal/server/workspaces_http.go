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
	if _, ok := a.id(w, r); !ok {
		return
	}
	a.fail(w, ErrProposalRequired)
}
