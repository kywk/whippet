package server

import (
	"bytes"
	"context"
	"database/sql"
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
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback()
	w, pid, err := readWorkspaceCore(ctx, tx, id, false)
	if err != nil {
		return w, err
	}
	w, err = fillWorkspace(ctx, tx, w, pid, p.Secrets != nil, p.CredentialTLS)
	if err != nil {
		return w, err
	}
	if err = tx.Commit(); err != nil {
		return w, err
	}
	return w, nil
}
func (p *Postgres) PatchWorkspace(context.Context, string, WorkspacePatch) (Workspace, error) {
	return Workspace{}, ErrProposalRequired
}
