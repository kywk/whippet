package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) error {
	// JSON can escape one script byte as six bytes; apply the actual script limit later.
	r.Body = http.MaxBytesReader(w, r.Body, 6*MaxScriptBytes+(64<<10))
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return fmt.Errorf("%w: invalid JSON request", ErrInvalid)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("%w: request must contain one JSON object", ErrInvalid)
	}
	return nil
}

func (a *API) createTest(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	item, err := a.store.CreateTest(r.Context(), id, body.Name, body.Description)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *API) draft(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	item, err := a.store.Draft(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) saveDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		EditingSessionID string  `json:"editingSessionId"`
		Revision         int     `json:"revision"`
		Script           *string `json:"script"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.Script == nil || body.Revision < 1 || !ValidID(body.EditingSessionID) {
		writeError(w, http.StatusBadRequest, "invalid_request", "positive revision and script are required")
		return
	}
	item, err := a.store.SaveDraft(r.Context(), id, body.EditingSessionID, body.Revision, *body.Script)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) validateDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		EditingSessionID string `json:"editingSessionId"`
		Revision         int    `json:"revision"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.Revision < 1 || !ValidID(body.EditingSessionID) {
		writeError(w, http.StatusBadRequest, "invalid_request", "positive revision is required")
		return
	}
	item, err := a.store.ValidateDraft(r.Context(), id, body.EditingSessionID, body.Revision)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, http.StatusAccepted, item)
}

func (a *API) publish(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		EditingSessionID string `json:"editingSessionId"`
		SummaryRunID     string `json:"summaryRunId"`
		Revision         int    `json:"revision"`
		Confirmed        bool   `json:"confirmed"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.Revision < 1 || !body.Confirmed || !ValidID(body.EditingSessionID) || !ValidID(body.SummaryRunID) {
		writeError(w, http.StatusBadRequest, "invalid_request", "positive revision and confirmed:true are required")
		return
	}
	item, err := a.store.Publish(r.Context(), id, body.EditingSessionID, body.Revision, body.SummaryRunID, body.Confirmed)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *API) versions(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	items, err := a.store.Versions(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
