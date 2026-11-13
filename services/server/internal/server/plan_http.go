package server

import (
	"context"
	"net/http"
)

type planStore interface {
	Plan(context.Context, string, string) (*Plan, error)
	SavePlan(context.Context, string, string, int, int, []PlanStageInput) (*Plan, error)
	ConfirmPlan(context.Context, string, int) (*Plan, error)
	CancelPlan(context.Context, string, int) (*Plan, error)
}

func (a *API) getPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	session := r.URL.Query().Get("editingSessionId")
	if !ValidID(session) {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(planStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	plan, err := store.Plan(r.Context(), id, session)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"plan": plan})
}
func (a *API) putPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		EditingSessionID string           `json:"editingSessionId"`
		Revision         int              `json:"revision"`
		PlanRevision     *int             `json:"planRevision"`
		Stages           []PlanStageInput `json:"stages"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if !ValidID(body.EditingSessionID) || body.Revision < 1 || body.PlanRevision == nil || *body.PlanRevision < 0 {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(planStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	plan, err := store.SavePlan(r.Context(), id, body.EditingSessionID, body.Revision, *body.PlanRevision, body.Stages)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"plan": plan})
}
func (a *API) confirmPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		PlanRevision int  `json:"planRevision"`
		Confirmed    bool `json:"confirmed"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.PlanRevision < 1 || !body.Confirmed {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(planStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	plan, err := store.ConfirmPlan(r.Context(), id, body.PlanRevision)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, 200, map[string]any{"plan": plan})
}
func (a *API) cancelPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		PlanRevision int `json:"planRevision"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.PlanRevision < 1 {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(planStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	plan, err := store.CancelPlan(r.Context(), id, body.PlanRevision)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, 200, map[string]any{"plan": plan})
}
func (a *API) publishPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		PlanRevision int    `json:"planRevision"`
		Confirmed    bool   `json:"confirmed"`
		SummaryRunID string `json:"summaryRunId"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.PlanRevision < 1 || !body.Confirmed || !ValidID(body.SummaryRunID) {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(interface {
		PublishPlan(context.Context, string, int, string) (PlanPublication, error)
	})
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	result, err := store.PublishPlan(r.Context(), id, body.PlanRevision, body.SummaryRunID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (a *API) createPlanSummary(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		PlanRevision    int    `json:"planRevision"`
		ValidationRunID string `json:"validationRunId"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.PlanRevision < 1 || !ValidID(body.ValidationRunID) {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(interface {
		CreatePlanSummary(context.Context, string, int, string) (Run, error)
	})
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	run, err := store.CreatePlanSummary(r.Context(), id, body.PlanRevision, body.ValidationRunID)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	status := 202
	if run.Status == "succeeded" {
		status = 200
	}
	writeJSON(w, status, map[string]any{"run": run})
}
func (a *API) getPlanSummary(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	store, ok := a.store.(interface {
		PlanSummary(context.Context, string) (*PlanSummary, error)
	})
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	summary, err := store.PlanSummary(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"summary": summary})
}
