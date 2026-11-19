package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
)

var errTestArchived = fmt.Errorf("%w: 此測試資產已封存", ErrConflict)

func (p *Postgres) ArchiveTest(ctx context.Context, id string) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = lockEditingTest(ctx, tx, id); errors.Is(err, errTestArchived) {
		return nil
	} else if err != nil {
		return err
	}

	var deleted, draftOpen bool
	if err := tx.QueryRowContext(ctx, `SELECT deleted_at IS NOT NULL, EXISTS(SELECT 1 FROM editing_sessions
 WHERE test_id=$1 AND status IN ('active','discarding')) FROM tests WHERE id=$1`, id).Scan(&deleted, &draftOpen); err != nil {
		return dbError(err)
	}
	if deleted {
		return ErrNotFound
	}
	if draftOpen {
		return fmt.Errorf("%w: 請先完成發佈或放棄草稿，再封存測試資產", ErrConflict)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE tests SET deleted_at=now(), archived_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit()
}

type testArchiveStore interface {
	ArchiveTest(context.Context, string) error
	ArchivedTests(context.Context, string) ([]Test, error)
}

func (a *API) archivedTests(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	store, ok := a.store.(testArchiveStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	items, err := store.ArchivedTests(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) archiveTest(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		Confirmed bool `json:"confirmed"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	if !body.Confirmed {
		a.fail(w, ErrInvalid)
		return
	}
	store, ok := a.store.(testArchiveStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	if err := store.ArchiveTest(r.Context(), id); err != nil {
		a.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
