package server

import "net/http"

func (a *API) conversation(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	sessionID := r.URL.Query().Get("editingSessionId")
	if sessionID != "" && !ValidID(sessionID) {
		writeError(w, 400, "invalid_request", "valid editing session ID required")
		return
	}
	conversation, err := a.store.Conversation(r.Context(), id, sessionID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, conversation)
}

func (a *API) createAuthor(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		EditingSessionID string `json:"editingSessionId"`
		Content          string `json:"content"`
		Revision         int    `json:"revision"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if err := validateUserMessage(body.Content); err != nil {
		a.fail(w, err)
		return
	}
	if body.Revision < 1 || !ValidID(body.EditingSessionID) {
		writeError(w, http.StatusBadRequest, "invalid_request", "positive revision is required")
		return
	}
	submission, err := a.store.CreateAuthor(r.Context(), id, body.EditingSessionID, body.Content, body.Revision)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, http.StatusAccepted, submission)
}
