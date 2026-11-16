package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
)

type agentTokenStore interface {
	CreateAgentToken(context.Context, string, string) (AgentToken, string, error)
	AgentTokens(context.Context, string) ([]AgentToken, error)
	RevokeAgentToken(context.Context, string, string) error
}

func (a *API) createAgentToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	workspace, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2048))
	if err != nil || strictJSONNoDuplicates(raw) != nil {
		a.fail(w, ErrInvalid)
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || decoder.Decode(new(any)) != io.EOF {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(agentTokenStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	item, secret, err := store.CreateAgentToken(r.Context(), workspace, body.Name)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": secret, "agentToken": item})
}

func (a *API) listAgentTokens(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	workspace, ok := a.id(w, r)
	if !ok {
		return
	}
	store, ok := a.store.(agentTokenStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	items, err := store.AgentTokens(r.Context(), workspace)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) revokeAgentToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	workspace, ok := a.id(w, r)
	if !ok {
		return
	}
	id := r.PathValue("tokenId")
	if !ValidID(id) {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(agentTokenStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	if err := store.RevokeAgentToken(r.Context(), workspace, id); err != nil {
		a.fail(w, err)
		return
	}
	if a.engine != nil {
		a.engine.refreshLive(r.Context())
		a.engine.Wake()
	}
	w.WriteHeader(http.StatusNoContent)
}
