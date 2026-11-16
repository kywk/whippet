package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
)

func (a *API) patchAuthorEngine(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		Revision     int    `json:"revision"`
		AuthorEngine string `json:"authorEngine"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil || strictJSONNoDuplicates(raw) != nil {
		a.fail(w, ErrInvalid)
		return
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&body) != nil || dec.Decode(new(any)) != io.EOF || body.Revision < 1 || (body.AuthorEngine != "builtin" && body.AuthorEngine != "external") {
		a.fail(w, ErrInvalid)
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	item, err := p.SetAuthorEngine(r.Context(), id, body.Revision, body.AuthorEngine)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (p *Postgres) SetAuthorEngine(ctx context.Context, id string, revision int, engine string) (Workspace, error) {
	if !ValidID(id) || revision < 1 || (engine != "builtin" && engine != "external") {
		return Workspace{}, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback()
	w, _, err := readWorkspaceCore(ctx, tx, id, true)
	if err != nil {
		return Workspace{}, err
	}
	if err = checkRevision(revision, w.Revision); err != nil {
		return Workspace{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE workspaces SET author_engine=$2,settings=jsonb_set(settings,'{revision}',to_jsonb($3::integer)) WHERE id=$1`, id, engine, revision+1); err != nil {
		return Workspace{}, err
	}
	if err = tx.Commit(); err != nil {
		return Workspace{}, err
	}
	return p.Workspace(ctx, id)
}
