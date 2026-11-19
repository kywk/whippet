package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

type TestMetadataPatch struct {
	MetadataRevision  int       `json:"metadataRevision"`
	Description       *string   `json:"description"`
	BackgroundSummary *string   `json:"backgroundSummary"`
	Tags              *[]string `json:"tags"`
}

func cleanTestTags(tags []string, limit int) ([]string, error) {
	if len(tags) > limit {
		return nil, fmt.Errorf("%w: at most %d tags", ErrInvalid, limit)
	}
	clean := make([]string, 0, len(tags))
	seen := make(map[string]bool, len(tags))
	for _, tag := range tags {
		if tag == "" || !utf8.ValidString(tag) || utf8.RuneCountInString(tag) > 32 ||
			strings.HasPrefix(tag, "#") || strings.ContainsAny(tag, ",，") || strings.ContainsFunc(tag, func(r rune) bool {
			return unicode.IsSpace(r) || unicode.IsControl(r) || r == '\uFEFF'
		}) {
			return nil, fmt.Errorf("%w: tags must be 1–32 characters without spaces, commas or a leading #", ErrInvalid)
		}
		if !seen[tag] {
			seen[tag] = true
			clean = append(clean, tag)
		}
	}
	return clean, nil
}

func tagArrayJSON(tags []string) string {
	if tags == nil {
		return "[]"
	}
	return jsonText(tags)
}

func (a *API) patchTestMetadata(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	var patch TestMetadataPatch
	if err := decodeBody(w, r, &patch); err != nil {
		a.fail(w, err)
		return
	}
	test, err := a.store.PatchTestMetadata(r.Context(), id, patch)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, test)
}

func (p *Postgres) PatchTestMetadata(ctx context.Context, testID string, patch TestMetadataPatch) (Test, error) {
	if patch.MetadataRevision < 1 || (patch.Description == nil && patch.BackgroundSummary == nil && patch.Tags == nil) {
		return Test{}, ErrInvalid
	}
	if patch.Description != nil && !validMetadataText(*patch.Description, 16384) {
		return Test{}, fmt.Errorf("%w: description exceeds 16384 bytes or contains invalid text", ErrInvalid)
	}
	if patch.BackgroundSummary != nil && !validMetadataText(*patch.BackgroundSummary, 8192) {
		return Test{}, fmt.Errorf("%w: background summary exceeds 8192 bytes or contains invalid text", ErrInvalid)
	}
	var tags any
	if patch.Tags != nil {
		clean, err := cleanTestTags(*patch.Tags, 20)
		if err != nil {
			return Test{}, err
		}
		tags = jsonText(clean)
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return Test{}, err
	}
	defer tx.Rollback()
	var revision int
	var versionID *string
	if err = tx.QueryRowContext(ctx, `SELECT metadata_revision,published_version_id FROM tests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, testID).Scan(&revision, &versionID); err != nil {
		return Test{}, dbError(err)
	}
	if revision != patch.MetadataRevision {
		return Test{}, fmt.Errorf("%w: test metadata changed", ErrConflict)
	}
	if patch.Description != nil || patch.BackgroundSummary != nil {
		if versionID == nil {
			return Test{}, fmt.Errorf("%w: script notes require a published version", ErrConflict)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO test_version_notes(version_id,description_override,background_summary_override)
 VALUES($1,$2,$3) ON CONFLICT(version_id) DO UPDATE SET
 description_override=COALESCE(EXCLUDED.description_override,test_version_notes.description_override),
 background_summary_override=COALESCE(EXCLUDED.background_summary_override,test_version_notes.background_summary_override)`,
			*versionID, patch.Description, patch.BackgroundSummary); err != nil {
			return Test{}, err
		}
	}
	test, err := scanTest(tx.QueryRowContext(ctx, `UPDATE tests SET tags=COALESCE($2::jsonb,tags),
 metadata_revision=metadata_revision+1 WHERE id=$1 RETURNING `+testColumns, testID, tags))
	if err != nil {
		return Test{}, err
	}
	return test, tx.Commit()
}

func validMetadataText(s string, limit int) bool {
	return len(s) <= limit && utf8.ValidString(s) && !strings.ContainsRune(s, '\x00')
}
