package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	"github.com/lib/pq"
)

const maxRunActivityTestIDs = 100

type runActivityItem struct {
	ID                string              `json:"id"`
	TestID            string              `json:"testId"`
	Status            string              `json:"status"`
	Kind              string              `json:"kind"`
	CreatedAt         time.Time           `json:"createdAt"`
	StartedAt         *time.Time          `json:"startedAt,omitempty"`
	FinishedAt        *time.Time          `json:"finishedAt,omitempty"`
	EditingSessionID  *string             `json:"editingSessionId"`
	DraftRevision     *int                `json:"draftRevision,omitempty"`
	ReportURL         string              `json:"reportUrl,omitempty"`
	AuthorMode        string              `json:"authorMode,omitempty"`
	AuthorEngine      string              `json:"authorEngine"`
	AuthorPartial     *runActivityPartial `json:"authorPartial,omitempty"`
	AuthorRepliedOnly bool                `json:"authorRepliedOnly,omitempty"`
	ProgressEvents    []string            `json:"progressEvents,omitempty"`
}

type runActivityPartial struct {
	Reason string `json:"reason"`
}

type runActivityStore interface {
	workspaceRunActivity(context.Context, string, []string) ([]runActivityItem, error)
}

func (a *API) runActivity(w http.ResponseWriter, r *http.Request) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	testIDs := query["testId"]
	if err != nil || len(testIDs) > maxRunActivityTestIDs {
		a.fail(w, ErrInvalid)
		return
	}
	for _, id := range testIDs {
		if !ValidID(id) {
			a.fail(w, ErrInvalid)
			return
		}
	}
	store, ok := a.store.(runActivityStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	ctx := r.Context()
	items, err := store.workspaceRunActivity(ctx, workspaceGrantFromContext(ctx).workspaceID, testIDs)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (p *Postgres) workspaceRunActivity(ctx context.Context, workspaceID string, testIDs []string) ([]runActivityItem, error) {
	if err := authorizeWorkspace(ctx, workspaceID); err != nil {
		return nil, err
	}
	query := `SELECT r.id,r.test_id,r.status,r.kind,r.created_at,r.started_at,r.finished_at,r.editing_session_id,r.draft_revision,` +
		runReportURL + `,` + runAuthorMode + `,r.author_engine,
    CASE WHEN r.author_partial IS NOT NULL THEN COALESCE(r.author_partial->>'reason','') END,` + runAuthorRepliedOnly + `,
    CASE WHEN r.kind='author' AND r.attempt_id IS NOT NULL AND r.status IN ('queued','dispatched','running','collecting','cancelling')
    THEN ` + runProgressEvents + ` END
    FROM runs r JOIN tests t ON t.id=r.test_id AND t.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND t.deleted_at IS NULL`
	args := []any{workspaceID}
	if len(testIDs) > 0 {
		query += ` AND r.test_id=ANY($2::uuid[])`
		args = append(args, pq.Array(testIDs))
	}
	rows, err := p.DB.QueryContext(ctx, query+` ORDER BY r.queue_seq DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []runActivityItem{}
	for rows.Next() {
		var item runActivityItem
		var partialReason *string
		var events []byte
		if err := rows.Scan(&item.ID, &item.TestID, &item.Status, &item.Kind, &item.CreatedAt, &item.StartedAt, &item.FinishedAt,
			&item.EditingSessionID, &item.DraftRevision, &item.ReportURL, &item.AuthorMode, &item.AuthorEngine,
			&partialReason, &item.AuthorRepliedOnly, &events); err != nil {
			return nil, err
		}
		if partialReason != nil {
			item.AuthorPartial = &runActivityPartial{Reason: *partialReason}
		}
		if len(events) > 0 {
			if err := json.Unmarshal(events, &item.ProgressEvents); err != nil {
				return nil, err
			}
		}
		item.CreatedAt = item.CreatedAt.UTC()
		items = append(items, item)
	}
	return items, rows.Err()
}
