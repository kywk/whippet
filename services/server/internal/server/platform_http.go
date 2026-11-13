package server

import (
	"context"
	"encoding/json"
	"net/http"
)

type platformStore interface {
	CreatePlatformTest(context.Context, string, string, string, string, *string) (Test, error)
	SavePlatformDraft(context.Context, string, string, int, string, *Module, []Stage) (Draft, error)
	Catalog(context.Context, string) ([]CatalogModule, error)
}
type CatalogReference struct {
	TestID    string `json:"testId"`
	VersionID string `json:"versionId"`
}
type CatalogModule struct {
	TestID           string             `json:"testId"`
	VersionID        string             `json:"versionId"`
	Name             string             `json:"name"`
	Description      string             `json:"description"`
	Module           Module             `json:"module"`
	ValidationRunID  *string            `json:"validationRunId"`
	ValidationStatus string             `json:"validationStatus"`
	ReferencedBy     []CatalogReference `json:"referencedBy"`
}

func (p *Postgres) Catalog(ctx context.Context, workspace string) ([]CatalogModule, error) {
	var exists bool
	if err := p.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)`, workspace).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := p.DB.QueryContext(ctx, `SELECT t.id,v.id,t.name,t.description,v.module,v.validation_run_id,COALESCE(r.status,''),
 COALESCE((SELECT jsonb_agg(jsonb_build_object('testId',source.test_id,'versionId',source.id) ORDER BY source.id)
 FROM version_dependencies dep JOIN test_versions source ON source.id=dep.version_id
 JOIN test_versions target ON target.id=dep.module_version_id WHERE target.test_id=t.id),'[]'::jsonb)
 FROM tests t JOIN test_versions v ON v.id=t.published_version_id LEFT JOIN runs r ON r.id=v.validation_run_id
 WHERE t.workspace_id=$1 AND t.kind='module' AND v.module IS NOT NULL ORDER BY t.slug`, workspace)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CatalogModule{}
	for rows.Next() {
		var item CatalogModule
		var module, refs []byte
		if err := rows.Scan(&item.TestID, &item.VersionID, &item.Name, &item.Description, &module, &item.ValidationRunID, &item.ValidationStatus, &refs); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(module, &item.Module); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(refs, &item.ReferencedBy); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
func (a *API) catalog(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	p, ok := a.store.(platformStore)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	items, err := p.Catalog(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
