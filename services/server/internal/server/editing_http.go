package server

import "net/http"

func (a *API) editingSession(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	sessionID := r.PathValue("sessionId")
	if sessionID != "" && !ValidID(sessionID) {
		writeError(w, 400, "invalid_request", "valid editing session ID required")
		return
	}
	session, err := a.store.EditingSession(r.Context(), id, sessionID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"session": session})
}
func (a *API) startEditing(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct{}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	session, created, err := a.store.StartEditingSession(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"session": session})
}
func (a *API) discardEditing(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	sessionID := r.PathValue("sessionId")
	var body struct {
		Revision  int  `json:"revision"`
		Confirmed bool `json:"confirmed"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if !ValidID(sessionID) || body.Revision < 1 || !body.Confirmed {
		writeError(w, 400, "invalid_request", "session, positive revision and confirmed:true are required")
		return
	}
	session, err := a.store.DiscardEditingSession(r.Context(), id, sessionID, body.Revision)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	status := http.StatusOK
	if session.Status == "discarding" {
		status = http.StatusAccepted
	}
	writeJSON(w, status, map[string]any{"session": session})
}
func (a *API) createSummary(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		EditingSessionID string `json:"editingSessionId"`
		Revision         int    `json:"revision"`
		ValidationRunID  string `json:"validationRunId"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if !ValidID(body.EditingSessionID) || !ValidID(body.ValidationRunID) || body.Revision < 1 {
		writeError(w, 400, "invalid_request", "session, revision and validation run are required")
		return
	}
	run, err := a.store.CreateSummary(r.Context(), id, body.EditingSessionID, body.Revision, body.ValidationRunID)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	status := http.StatusAccepted
	if run.Status == "succeeded" {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"run": run})
}
