package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type ActiveEditingSession struct {
	ID            string    `json:"id"`
	Status        string    `json:"status"`
	DraftRevision int       `json:"draftRevision"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type SourceVersion struct {
	ID                string  `json:"id"`
	Description       *string `json:"description"`
	BackgroundSummary *string `json:"backgroundSummary"`
}

type EditingSummary struct {
	RunID                string  `json:"runId"`
	Status               string  `json:"status"`
	Revision             int     `json:"revision"`
	ValidationRunID      string  `json:"validationRunId"`
	Description          *string `json:"description,omitempty"`
	BackgroundSummary    *string `json:"backgroundSummary,omitempty"`
	Name                 *string `json:"name,omitempty"`
	ValidForCurrentDraft bool    `json:"validForCurrentDraft"`
}

type EditingSession struct {
	ID                  string          `json:"id"`
	TestID              string          `json:"testId"`
	WorkspaceID         string          `json:"workspaceId"`
	Status              string          `json:"status"`
	SourceVersionID     *string         `json:"sourceVersionId"`
	SourceVersion       *SourceVersion  `json:"sourceVersion"`
	ConversationID      string          `json:"conversationId"`
	ConversationSummary *string         `json:"conversationSummary"`
	ContextRevision     int64           `json:"contextRevision"`
	Draft               *Draft          `json:"draft"`
	Summary             *EditingSummary `json:"summary"`
	PendingRunIDs       []string        `json:"pendingRunIds"`
	ReclaimPending      bool            `json:"reclaimPending"`
	PublishedVersionID  *string         `json:"publishedVersionId"`
	CreatedAt           time.Time       `json:"createdAt"`
	ClosedAt            *time.Time      `json:"closedAt"`
}

type queryDB interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// The only entry to draft writes: Workspace SHARE -> Test -> Session/Draft -> Run.
func lockEditingTest(ctx context.Context, tx *sql.Tx, testID string) (*WorkspaceSettings, error) {
	var raw []byte
	if err := tx.QueryRowContext(ctx, `SELECT w.settings FROM workspaces w JOIN tests t ON t.workspace_id=w.id WHERE t.id=$1 FOR SHARE OF w`, testID).Scan(&raw); err != nil {
		return nil, dbError(err)
	}
	var id string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM tests WHERE id=$1 FOR UPDATE`, testID).Scan(&id); err != nil {
		return nil, dbError(err)
	}
	return decodeSettings(raw)
}

const editingSelect = `SELECT e.id,e.test_id,t.workspace_id,e.status,e.source_version_id,e.conversation_id,
 e.conversation_summary,e.context_revision,e.published_version_id,e.created_at,e.closed_at,v.description,v.background_summary
 FROM editing_sessions e JOIN tests t ON t.id=e.test_id LEFT JOIN test_versions v ON v.id=e.source_version_id`

func scanEditing(row scanner) (EditingSession, error) {
	var s EditingSession
	var description, background *string
	err := row.Scan(&s.ID, &s.TestID, &s.WorkspaceID, &s.Status, &s.SourceVersionID, &s.ConversationID, &s.ConversationSummary, &s.ContextRevision, &s.PublishedVersionID, &s.CreatedAt, &s.ClosedAt, &description, &background)
	if s.SourceVersionID != nil {
		s.SourceVersion = &SourceVersion{*s.SourceVersionID, description, background}
	}
	s.CreatedAt = s.CreatedAt.UTC()
	s.PendingRunIDs = []string{}
	return s, dbError(err)
}

func readEditing(ctx context.Context, q queryDB, testID, id string) (EditingSession, error) {
	if id == "" {
		return scanEditing(q.QueryRowContext(ctx, editingSelect+` WHERE e.test_id=$1 AND e.status IN ('active','discarding')`, testID))
	}
	return scanEditing(q.QueryRowContext(ctx, editingSelect+` WHERE e.test_id=$1 AND e.id=$2`, testID, id))
}

func fillEditing(ctx context.Context, q queryDB, s EditingSession) (EditingSession, error) {
	if s.Status == "active" || s.Status == "discarding" {
		d, err := scanDraft(q.QueryRowContext(ctx, draftSelect, s.TestID))
		if err != nil {
			return s, err
		}
		if d.EditingSessionID != s.ID {
			return s, ErrConflict
		}
		s.Draft = &d.Draft
		s.Summary, err = readEditingSummary(ctx, q, s, d)
		if err != nil {
			return s, err
		}
	}
	rows, err := q.QueryContext(ctx, `SELECT id,NOT slot_released FROM runs WHERE editing_session_id=$1
 AND (status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted') OR NOT slot_released) ORDER BY queue_seq`, s.ID)
	if err != nil {
		return s, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var occupied bool
		if err := rows.Scan(&id, &occupied); err != nil {
			return s, err
		}
		s.PendingRunIDs = append(s.PendingRunIDs, id)
		s.ReclaimPending = s.ReclaimPending || occupied
	}
	return s, rows.Err()
}

func (p *Postgres) EditingSession(ctx context.Context, testID, id string) (*EditingSession, error) {
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM tests WHERE id=$1)`, testID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	s, err := readEditing(ctx, tx, testID, id)
	if id == "" && errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s, err = fillEditing(ctx, tx, s)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &s, nil
}

func (p *Postgres) StartEditingSession(ctx context.Context, testID string) (EditingSession, bool, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return EditingSession{}, false, err
	}
	defer tx.Rollback()
	settings, err := lockEditingTest(ctx, tx, testID)
	if err != nil {
		return EditingSession{}, false, err
	}
	s, err := readEditing(ctx, tx, testID, "")
	created := false
	if errors.Is(err, ErrNotFound) {
		created = true
		id, conversationID := NewID(), NewID()
		if _, err = tx.ExecContext(ctx, `INSERT INTO editing_sessions(id,test_id,status,source_version_id,conversation_id)
          SELECT $1,id,'active',published_version_id,$3 FROM tests WHERE id=$2`, id, testID, conversationID); err != nil {
			return s, false, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO conversations(id,test_id,editing_session_id,workspace_id) SELECT $1,id,$3,workspace_id FROM tests WHERE id=$2`, conversationID, testID, id); err != nil {
			return s, false, err
		}
		var script, origin string
		var module, stages []byte
		if err = tx.QueryRowContext(ctx, `SELECT COALESCE(v.script,''),COALESCE(v.script_origin,'legacy'),COALESCE(v.module,'null'::jsonb),COALESCE(v.stages,'[]'::jsonb) FROM tests t LEFT JOIN test_versions v ON v.id=t.published_version_id WHERE t.id=$1`, testID).Scan(&script, &origin, &module, &stages); err != nil {
			return s, false, err
		}
		var revision int
		workspaceContext, contextErr := contextForTest(ctx, tx, testID)
		if contextErr != nil {
			return s, false, contextErr
		}
		if err = tx.QueryRowContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings,workspace_context,script_origin,module,stages)
          SELECT $1,COALESCE(MAX(revision),0)+1,$2,$3,$4,$5,$6,$7,$8,$9 FROM draft_revisions WHERE test_id=$1 RETURNING revision`, testID, script, scriptHash(script), settings.TimeoutMS, settingsJSON(settings), jsonText(workspaceContext), origin, string(module), string(stages)).Scan(&revision); err != nil {
			return s, false, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO drafts(test_id,current_revision,editing_session_id) VALUES($1,$2,$3)`, testID, revision, id); err != nil {
			return s, false, err
		}
		s, err = readEditing(ctx, tx, testID, id)
	}
	if err != nil {
		return s, false, err
	}
	if s.Status != "active" {
		return s, false, fmt.Errorf("%w: editing session is closing", ErrConflict)
	}
	s, err = fillEditing(ctx, tx, s)
	if err != nil {
		return s, false, err
	}
	if err = tx.Commit(); err != nil {
		return s, false, err
	}
	return s, created, nil
}

func requireEditingDraft(ctx context.Context, tx *sql.Tx, testID, id string) (draftState, EditingSession, error) {
	if !ValidID(id) {
		return draftState{}, EditingSession{}, ErrInvalid
	}
	if _, err := lockEditingTest(ctx, tx, testID); err != nil {
		return draftState{}, EditingSession{}, err
	}
	s, err := readEditing(ctx, tx, testID, id)
	if err != nil {
		return draftState{}, s, err
	}
	if s.Status != "active" {
		return draftState{}, s, fmt.Errorf("%w: editing session is not active", ErrConflict)
	}
	d, err := scanDraft(tx.QueryRowContext(ctx, draftSelect+` FOR UPDATE OF d`, testID))
	if err == nil && d.EditingSessionID != id {
		err = ErrConflict
	}
	return d, s, err
}

func finishDiscard(ctx context.Context, tx *sql.Tx, testID, id string) error {
	var pending bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM runs WHERE editing_session_id=$1
      AND (status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted') OR NOT slot_released))`, id).Scan(&pending); err != nil {
		return err
	}
	if pending {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE editing_sessions SET status='discarded',closed_at=now() WHERE id=$1 AND test_id=$2 AND status='discarding'`, id, testID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM drafts WHERE test_id=$1 AND editing_session_id=$2 AND EXISTS(SELECT 1 FROM editing_sessions WHERE id=$2 AND status='discarded')`, testID, id)
	return err
}

func (p *Postgres) DiscardEditingSession(ctx context.Context, testID, id string, revision int) (EditingSession, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return EditingSession{}, err
	}
	defer tx.Rollback()
	if _, err = lockEditingTest(ctx, tx, testID); err != nil {
		return EditingSession{}, err
	}
	s, err := readEditing(ctx, tx, testID, id)
	if err != nil {
		return s, err
	}
	if s.Status == "published" {
		return s, ErrConflict
	}
	if s.Status == "active" {
		d, err := scanDraft(tx.QueryRowContext(ctx, draftSelect, testID))
		if err != nil {
			return s, err
		}
		if err = checkRevision(revision, d.Revision); err != nil {
			return s, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET status='discarding' WHERE id=$1`, id); err != nil {
			return s, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,
          finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE editing_session_id=$1
          AND status IN ('queued','dispatched','running','collecting')`, id); err != nil {
			return s, err
		}
	}
	if err = finishDiscard(ctx, tx, testID, id); err != nil {
		return s, err
	}
	s, err = readEditing(ctx, tx, testID, id)
	if err != nil {
		return s, err
	}
	s, err = fillEditing(ctx, tx, s)
	if err != nil {
		return s, err
	}
	if err = tx.Commit(); err != nil {
		return s, err
	}
	return s, nil
}

// Called independently, after heartbeat/result transactions have committed. It
// must also run without a connected Manager, including after a server restart.
func (p *Postgres) FinalizeDiscardingSessions(ctx context.Context) error {
	rows, err := p.DB.QueryContext(ctx, `SELECT test_id,id FROM editing_sessions WHERE status='discarding' ORDER BY id LIMIT 32`)
	if err != nil {
		return err
	}
	var targets [][2]string
	for rows.Next() {
		var pair [2]string
		if err := rows.Scan(&pair[0], &pair[1]); err != nil {
			rows.Close()
			return err
		}
		targets = append(targets, pair)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, pair := range targets {
		tx, err := p.DB.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err = lockEditingTest(ctx, tx, pair[0]); err == nil {
			err = finishDiscard(ctx, tx, pair[0], pair[1])
		}
		if err == nil {
			err = tx.Commit()
		} else {
			tx.Rollback()
		}
		if err != nil {
			return err
		}
	}
	return nil
}
