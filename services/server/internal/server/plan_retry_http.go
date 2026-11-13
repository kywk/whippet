package server

import (
	"context"
	"net/http"
)

type stageRetryStore interface {
	StageRetry(context.Context, string, string) (StageRetry, error)
	RetryPlanStage(context.Context, string, string, StageRetryRequest) (*Plan, error)
}

func (a *API) stageRetry(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	store, ok := a.store.(stageRetryStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	stage := r.PathValue("stageId")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet {
		result, err := store.StageRetry(r.Context(), id, stage)
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"retry": result})
		return
	}
	var body struct {
		PlanRevision          *int    `json:"planRevision"`
		ModuleRevision        *int    `json:"moduleRevision"`
		ModuleContextRevision *int64  `json:"moduleContextRevision"`
		Confirmed             *bool   `json:"confirmed"`
		Content               *string `json:"content"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.PlanRevision == nil || body.ModuleRevision == nil || body.ModuleContextRevision == nil || body.Confirmed == nil || body.Content == nil {
		a.fail(w, ErrInvalid)
		return
	}
	result, err := store.RetryPlanStage(r.Context(), id, stage, StageRetryRequest{*body.PlanRevision, *body.ModuleRevision, *body.ModuleContextRevision, *body.Confirmed, *body.Content})
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"plan": result})
}
