package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type WorkspaceSite struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// A bounded, non-secret snapshot, copied into each immutable revision and task.
type WorkspaceSettings struct {
	Revision       int             `json:"revision"`
	Sites          []WorkspaceSite `json:"sites"`
	DefaultTestURL string          `json:"defaultTestUrl"`
	TimeoutMS      int             `json:"timeoutMs"`
}

type WorkspacePatch struct {
	Revision       int              `json:"revision"`
	Sites          *[]WorkspaceSite `json:"sites,omitempty"`
	DefaultTestURL *string          `json:"defaultTestUrl,omitempty"`
	TimeoutMS      *int             `json:"timeoutMs,omitempty"`
}

func (p *WorkspacePatch) UnmarshalJSON(data []byte) error {
	// Optional fields may be omitted; explicit null is not a setting value.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for _, value := range raw {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("workspace fields cannot be null")
		}
	}
	type fields WorkspacePatch
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode((*fields)(p))
}

func validWebsiteURL(raw string) bool {
	if !utf8.ValidString(raw) || utf8.RuneCountInString(raw) > 2048 || strings.IndexFunc(raw, unicode.IsSpace) >= 0 ||
		strings.IndexFunc(raw, unicode.IsControl) >= 0 {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		return err == nil && n > 0 && n <= 65535
	}
	return !strings.HasSuffix(u.Host, ":")
}

func applyWorkspacePatch(current WorkspaceSettings, patch WorkspacePatch) (WorkspaceSettings, bool, error) {
	if err := checkRevision(patch.Revision, current.Revision); err != nil {
		return WorkspaceSettings{}, false, err
	}
	next := current
	next.Sites = slices.Clone(current.Sites)
	if patch.Sites != nil {
		next.Sites = slices.Clone(*patch.Sites)
	}
	if next.Sites == nil {
		next.Sites = []WorkspaceSite{}
	}
	if patch.DefaultTestURL != nil {
		next.DefaultTestURL = *patch.DefaultTestURL
	}
	if patch.TimeoutMS != nil {
		next.TimeoutMS = *patch.TimeoutMS
	}
	if len(next.Sites) > 20 {
		return WorkspaceSettings{}, false, fmt.Errorf("%w: at most 20 sites are allowed", ErrInvalid)
	}
	for i := range next.Sites {
		next.Sites[i].Name = strings.TrimSpace(next.Sites[i].Name)
		if next.Sites[i].Name == "" || !utf8.ValidString(next.Sites[i].Name) || utf8.RuneCountInString(next.Sites[i].Name) > 100 ||
			strings.IndexFunc(next.Sites[i].Name, unicode.IsControl) >= 0 || !validWebsiteURL(next.Sites[i].URL) {
			return WorkspaceSettings{}, false, fmt.Errorf("%w: each site needs a name (1..100 characters) and an HTTP(S) URL without userinfo (max 2048 characters)", ErrInvalid)
		}
	}
	if next.DefaultTestURL != "" && !validWebsiteURL(next.DefaultTestURL) {
		return WorkspaceSettings{}, false, fmt.Errorf("%w: defaultTestUrl must be empty or an HTTP(S) URL without userinfo (max 2048 characters)", ErrInvalid)
	}
	if next.TimeoutMS < 1 || next.TimeoutMS > 3600000 {
		return WorkspaceSettings{}, false, fmt.Errorf("%w: timeoutMs must be an integer in 1..3600000", ErrInvalid)
	}
	changed := !sameWorkspaceSettings(&current, &next)
	if changed {
		next.Revision++
	}
	return next, changed, nil
}

func sameWorkspaceSettings(a, b *WorkspaceSettings) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Revision == b.Revision && a.DefaultTestURL == b.DefaultTestURL && a.TimeoutMS == b.TimeoutMS && slices.Equal(a.Sites, b.Sites)
}

func settingsJSON(settings *WorkspaceSettings) string {
	// This closed struct contains only JSON primitives; marshaling cannot fail.
	data, _ := json.Marshal(settings)
	return string(data)
}

func decodeSettings(data []byte) (*WorkspaceSettings, error) {
	var settings WorkspaceSettings
	if err := json.Unmarshal(data, &settings); err != nil || settings.Revision < 1 || settings.TimeoutMS < 1 || settings.Sites == nil {
		return nil, fmt.Errorf("invalid workspace settings snapshot")
	}
	return &settings, nil
}

const workspaceColumns = `id,name,settings`

func scanWorkspace(row scanner) (Workspace, error) {
	var w Workspace
	var data []byte
	if err := row.Scan(&w.ID, &w.Name, &data); err != nil {
		return w, dbError(err)
	}
	s, err := decodeSettings(data)
	if err == nil {
		w.WorkspaceSettings = *s
	}
	return w, err
}

func (p *Postgres) Workspace(ctx context.Context, id string) (Workspace, error) {
	return scanWorkspace(p.DB.QueryRowContext(ctx, `SELECT `+workspaceColumns+` FROM workspaces WHERE id=$1`, id))
}

func (p *Postgres) PatchWorkspace(ctx context.Context, id string, patch WorkspacePatch) (Workspace, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback()
	w, err := scanWorkspace(tx.QueryRowContext(ctx, `SELECT `+workspaceColumns+` FROM workspaces WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return Workspace{}, err
	}
	next, changed, err := applyWorkspacePatch(w.WorkspaceSettings, patch)
	if err != nil {
		return Workspace{}, err
	}
	if changed {
		// Every draft writer first holds this Workspace's share lock. Lock Test
		// rows in a stable order, without changing queued tasks or published versions.
		rows, err := tx.QueryContext(ctx, `SELECT id FROM tests WHERE workspace_id=$1 ORDER BY id FOR UPDATE`, id)
		if err != nil {
			return Workspace{}, err
		}
		for rows.Next() {
			var testID string
			if err := rows.Scan(&testID); err != nil {
				rows.Close()
				return Workspace{}, err
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return Workspace{}, err
		}
		data := settingsJSON(&next)
		if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET settings=$2 WHERE id=$1`, id, data); err != nil {
			return Workspace{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO draft_revisions(test_id,revision,script,script_hash,timeout_ms,workspace_settings)
		    SELECT dr.test_id,dr.revision+1,dr.script,dr.script_hash,$2,$3 FROM drafts d
		    JOIN tests t ON t.id=d.test_id JOIN draft_revisions dr ON dr.test_id=d.test_id AND dr.revision=d.current_revision
		    WHERE t.workspace_id=$1`, id, next.TimeoutMS, data); err != nil {
			return Workspace{}, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE drafts d SET current_revision=current_revision+1,validation_run_id=NULL,updated_at=now()
		    FROM tests t WHERE d.test_id=t.id AND t.workspace_id=$1`, id); err != nil {
			return Workspace{}, err
		}
		w.WorkspaceSettings = next
	}
	if err := tx.Commit(); err != nil {
		return Workspace{}, err
	}
	return w, nil
}
