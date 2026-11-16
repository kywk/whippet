package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
)

func (a *API) splitPlanStage(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
	if err != nil || strictJSONNoDuplicates(raw) != nil || !requiredJSONFields(raw, "planRevision", "confirmed", "stages") {
		a.fail(w, ErrInvalid)
		return
	}
	var request StageSplitRequest
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&request) != nil || d.Decode(new(any)) != io.EOF {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(interface {
		SplitPlanStage(context.Context, string, string, StageSplitRequest) (*Plan, error)
	})
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	plan, err := store.SplitPlanStage(r.Context(), id, r.PathValue("stageId"), request)
	if err != nil {
		a.fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"plan": plan})
}
