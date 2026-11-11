package server

import (
	"context"
	"net"
	"net/http"
	"strings"
)

func (a *API) createWorkspace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	item, err := a.store.CreateWorkspace(r.Context(), body.Name)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 201, item)
}
func (a *API) workspaceConversation(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	item, err := a.store.WorkspaceConversation(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, item)
}
func (a *API) workspaceMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		Content         string `json:"content"`
		Revision        int    `json:"revision"`
		ContextRevision *int64 `json:"contextRevision"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.Revision < 1 || body.ContextRevision == nil || *body.ContextRevision < 0 {
		writeError(w, 400, "invalid_request", "revision and contextRevision are required")
		return
	}
	item, err := a.store.CreateWorkspaceAuthor(r.Context(), id, body.Content, body.Revision, *body.ContextRevision)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	writeJSON(w, 202, item)
}
func (a *API) workspaceProposal(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	pid := r.PathValue("proposalId")
	if !ValidID(pid) {
		writeError(w, 400, "invalid_request", "valid proposal ID required")
		return
	}
	item, err := a.store.WorkspaceProposal(r.Context(), id, pid)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, item)
}
func (a *API) workspaceProposalAction(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	pid := r.PathValue("proposalId")
	action := r.PathValue("action")
	if !ValidID(pid) || (action != "confirm" && action != "cancel" && action != "confirm-scope") {
		writeError(w, 400, "invalid_request", "valid proposal action required")
		return
	}
	var body struct {
		BaseRevision int  `json:"baseRevision"`
		Confirmed    bool `json:"confirmed"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if body.BaseRevision < 1 || !body.Confirmed {
		writeError(w, 400, "invalid_request", "baseRevision and confirmed:true are required")
		return
	}
	workspace, proposal, err := a.store.ActWorkspaceProposal(r.Context(), id, pid, action, body.BaseRevision)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.engine.Wake()
	if action == "confirm" {
		writeJSON(w, 200, map[string]any{"workspace": workspace, "proposal": proposal})
	} else {
		writeJSON(w, 200, proposal)
	}
}

func protectedCredentialTransport(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	host := r.URL.Hostname()
	if host == "" {
		host = r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
	}
	localHost := strings.EqualFold(host, "localhost")
	if ip := net.ParseIP(host); ip != nil {
		localHost = ip.IsLoopback()
	}
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(remote)
	return localHost && ip != nil && ip.IsLoopback()
}
func (a *API) workspaceCredentials(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	role := r.PathValue("roleId")
	if !ValidID(role) {
		writeError(w, 400, "invalid_request", "valid role ID required")
		return
	}
	if !protectedCredentialTransport(r) {
		writeError(w, 400, "protected_transport_required", "credentials require HTTPS or a direct loopback connection")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	if r.Method == http.MethodPut {
		var body struct {
			Expected *int   `json:"expectedSecretVersion"`
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := decodeBody(w, r, &body); err != nil {
			a.fail(w, err)
			return
		}
		if body.Expected == nil || *body.Expected < 0 {
			writeError(w, 400, "invalid_request", "expectedSecretVersion is required")
			return
		}
		ref, err := a.store.SaveWorkspaceCredentials(r.Context(), id, role, *body.Expected, credentialValues{body.Username, body.Password})
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, 200, ref)
	} else {
		var body struct {
			Expected  *int `json:"expectedSecretVersion"`
			Confirmed bool `json:"confirmed"`
		}
		if err := decodeBody(w, r, &body); err != nil {
			a.fail(w, err)
			return
		}
		if body.Expected == nil || *body.Expected < 0 || !body.Confirmed {
			writeError(w, 400, "invalid_request", "expectedSecretVersion and confirmed:true required")
			return
		}
		ref, err := a.store.RevokeWorkspaceCredentials(r.Context(), id, role, *body.Expected)
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, 200, ref)
	}
}

// Current provider is Superadmin. Resource ownership is nevertheless obtained
// from trusted database relations; optional client scope never grants access.
func authorizeWorkspace(_ context.Context, _ string) error { return nil }
func (p *Postgres) ResourceWorkspace(ctx context.Context, kind, id string) (string, error) {
	query := ""
	switch kind {
	case "workspaces":
		query = `SELECT id FROM workspaces WHERE id=$1`
	case "tests":
		query = `SELECT workspace_id FROM tests WHERE id=$1`
	case "runs":
		query = `SELECT workspace_id FROM runs WHERE id=$1`
	default:
		return "", ErrNotFound
	}
	var workspace string
	err := p.DB.QueryRowContext(ctx, query, id).Scan(&workspace)
	if err != nil {
		return "", dbError(err)
	}
	return workspace, authorizeWorkspace(ctx, workspace)
}
func (a *API) authorizeResource(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || parts[0] != "api" || (parts[1] != "tests" && parts[1] != "runs" && parts[1] != "workspaces") || !ValidID(parts[2]) {
		return true
	}
	authorizer, ok := a.store.(interface {
		ResourceWorkspace(context.Context, string, string) (string, error)
	})
	if !ok {
		return true
	}
	workspace, err := authorizer.ResourceWorkspace(r.Context(), parts[1], parts[2])
	if err != nil {
		a.fail(w, err)
		return false
	}
	if expected := r.URL.Query().Get("workspaceId"); expected != "" && expected != workspace {
		a.fail(w, ErrNotFound)
		return false
	}
	return true
}
