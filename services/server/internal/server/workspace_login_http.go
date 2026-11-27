package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

func readWorkspaceLoginBody(w http.ResponseWriter, r *http.Request, dst any, keys ...string) error {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil || !utf8.Valid(raw) || strictJSONNoDuplicates(raw) != nil || !requiredJSONFields(raw, keys...) || json.Unmarshal(raw, dst) != nil {
		return ErrInvalid
	}
	return nil
}

func (a *API) workspaceProposalCredentials(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	workspace, ok := a.id(w, r)
	if !ok {
		return
	}
	proposalID, accountID := r.PathValue("proposalId"), strings.ToLower(r.PathValue("accountId"))
	if !ValidID(proposalID) || !ValidID(accountID) {
		a.fail(w, ErrInvalid)
		return
	}
	if !protectedCredentialTransport(r) {
		writeError(w, 400, "protected_transport_required", "credentials require HTTPS or a direct loopback connection")
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrSecretsUnavailable)
		return
	}
	var request struct {
		BaseRevision int    `json:"baseRevision"`
		Expected     int    `json:"expectedSecretVersion"`
		Username     string `json:"username"`
		Password     string `json:"password"`
		Confirmed    bool   `json:"confirmed"`
	}
	var values *credentialValues
	if r.Method == http.MethodPut {
		if err := readWorkspaceLoginBody(w, r, &request, "baseRevision", "expectedSecretVersion", "username", "password"); err != nil {
			a.fail(w, err)
			return
		}
		values = &credentialValues{request.Username, request.Password}
	} else {
		if err := readWorkspaceLoginBody(w, r, &request, "baseRevision", "expectedSecretVersion", "confirmed"); err != nil || !request.Confirmed {
			a.fail(w, ErrInvalid)
			return
		}
	}
	if request.BaseRevision < 1 || request.Expected < 0 {
		a.fail(w, ErrInvalid)
		return
	}
	status, err := p.changeProposalCredentials(r.Context(), workspace, proposalID, accountID, request.BaseRevision, request.Expected, values)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, 200, status)
}

func (a *API) verifyWorkspaceLogin(w http.ResponseWriter, r *http.Request) {
	workspace, ok := a.id(w, r)
	if !ok {
		return
	}
	proposalID := r.PathValue("proposalId")
	var request workspaceLoginRequest
	if !ValidID(proposalID) || readWorkspaceLoginBody(w, r, &request, "baseRevision", "requestId", "accountId", "targetOrigin") != nil {
		a.fail(w, ErrInvalid)
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrSecurityUnavailable)
		return
	}
	run, err := p.queueWorkspaceLogin(r.Context(), workspace, proposalID, request)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, 202, map[string]Run{"run": run})
}

func (a *API) patchWorkspaceTestAccount(w http.ResponseWriter, r *http.Request) {
	workspace, ok := a.id(w, r)
	if !ok {
		return
	}
	accountID := strings.ToLower(r.PathValue("accountId"))
	var request testAccountPatch
	if !ValidID(accountID) || readWorkspaceLoginBody(w, r, &request, "revision", "name", "role", "purpose") != nil {
		a.fail(w, ErrInvalid)
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrNotFound)
		return
	}
	item, err := p.patchTestAccount(r.Context(), workspace, accountID, request)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, 200, presentWorkspace(item, workspaceGrantFromContext(r.Context()).permissions))
}
