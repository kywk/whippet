package server

import (
	"context"
	"database/sql"
	"encoding/json"
)

type ModuleSummarySnapshot struct {
	SchemaVersion int    `json:"schemaVersion"`
	Module        Module `json:"module"`
	BundleHash    string `json:"bundleHash"`
	BodyHash      string `json:"bodyHash"`
	HarnessHash   string `json:"harnessHash"`
}

func moduleSummarySnapshot(d draftState) (*ModuleSummarySnapshot, error) {
	if d.Module == nil || validateModule(d.Module, d.Module.Slug) != nil || len(d.Script) > MaxScriptBytes {
		return nil, ErrInvalid
	}
	origin := fileOrigin(d.ScriptOrigin)
	bundle := RunBundle{SchemaVersion: 1, Module: d.Module, Files: []RunFile{{Path: "tests/test.spec.ts", Content: d.Module.Harness, Origin: origin}, {Path: "lib/" + d.Module.Slug + ".ts", Content: d.Script, Origin: origin}}}
	hash, err := bundle.hash()
	if err != nil {
		return nil, err
	}
	snapshot := &ModuleSummarySnapshot{1, *d.Module, hash, scriptHash(d.Script), scriptHash(d.Module.Harness)}
	raw, err := json.Marshal(snapshot)
	if err != nil || int64(len(raw)) > MaxAuthorArtifactBytes {
		return nil, ErrInvalid
	}
	return snapshot, nil
}
func moduleSummaryMatches(d draftState, input AuthorInput) bool {
	if input.Batch != nil || input.Platform != nil {
		return false
	}
	if d.Module == nil {
		return input.ModuleSummary == nil
	}
	expected, err := moduleSummarySnapshot(d)
	if err != nil || input.ModuleSummary == nil {
		return false
	}
	return jsonText(expected) == jsonText(input.ModuleSummary)
}
func reserveModuleVersion(ctx context.Context, tx *sql.Tx, d draftState, hash string) (string, error) {
	if _, err := tx.ExecContext(ctx, `INSERT INTO module_version_candidates(id,test_id,editing_session_id,revision,bundle_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(test_id,editing_session_id,revision,bundle_hash) DO NOTHING`, NewID(), d.TestID, d.EditingSessionID, d.Revision, hash); err != nil {
		return "", err
	}
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM module_version_candidates WHERE test_id=$1 AND editing_session_id=$2 AND revision=$3 AND bundle_hash=$4`, d.TestID, d.EditingSessionID, d.Revision, hash).Scan(&id)
	return id, err
}
func runReclaimed(ctx context.Context, q queryDB, id string) bool {
	var released bool
	return q.QueryRowContext(ctx, `SELECT slot_released FROM runs WHERE id=$1`, id).Scan(&released) == nil && released
}
func summaryTargetKind(ctx context.Context, q queryDB, test string) (string, error) {
	var kind string
	if err := q.QueryRowContext(ctx, `SELECT kind FROM tests WHERE id=$1`, test).Scan(&kind); err != nil {
		return "", dbError(err)
	}
	if kind != "test" && kind != "module" {
		return "", ErrConflict
	}
	return kind, nil
}
