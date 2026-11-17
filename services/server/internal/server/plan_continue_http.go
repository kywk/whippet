package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
)

func (a *API) continuePlanStage(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil || strictJSONNoDuplicates(raw) != nil || !requiredJSONFields(raw, "planRevision", "sourceRunId", "moduleRevision", "confirmed") {
		a.fail(w, ErrInvalid)
		return
	}
	var body StageContinueRequest
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil || d.Decode(new(any)) != io.EOF {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(interface {
		ContinuePlanStage(context.Context, string, string, StageContinueRequest) (*Plan, error)
	})
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	result, err := store.ContinuePlanStage(r.Context(), id, r.PathValue("stageId"), body)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"plan": result})
}
