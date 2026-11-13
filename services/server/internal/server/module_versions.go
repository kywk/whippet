package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type pinnedModule struct {
	Script, Origin string
	Module         Module
}

func readPinnedModule(ctx context.Context, q queryDB, workspace, test, version, plan string) (pinnedModule, error) {
	var m pinnedModule
	var raw []byte
	err := q.QueryRowContext(ctx, `SELECT v.script,v.script_origin,v.module FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.id=$1 AND t.id=$2 AND t.workspace_id=$3 AND t.kind='module' AND v.module IS NOT NULL`, version, test, workspace).Scan(&m.Script, &m.Origin, &raw)
	if errors.Is(err, sql.ErrNoRows) && plan != "" {
		var hash string
		err = q.QueryRowContext(ctx, `SELECT r.script,r.script_origin,r.module,c.bundle_hash FROM plan_module_candidates c JOIN plans p ON p.id=c.plan_id JOIN tests t ON t.id=c.test_id JOIN drafts d ON d.test_id=c.test_id AND d.editing_session_id=c.editing_session_id AND d.current_revision=c.revision JOIN editing_sessions e ON e.id=c.editing_session_id AND e.status='active' AND e.context_revision=c.context_revision JOIN draft_revisions r ON r.test_id=c.test_id AND r.revision=c.revision WHERE c.id=$1 AND c.test_id=$2 AND t.workspace_id=$3 AND c.plan_id=$4 AND p.status IN ('running','composed')`, version, test, workspace, plan).Scan(&m.Script, &m.Origin, &raw, &hash)
		if err != nil {
			return m, dbError(err)
		}
		if json.Unmarshal(raw, &m.Module) != nil || validateModule(&m.Module, m.Module.Slug) != nil {
			return m, ErrInvalid
		}
		bundle := RunBundle{SchemaVersion: 1, Module: &m.Module, Files: []RunFile{{Path: "tests/test.spec.ts", Content: m.Module.Harness, Origin: fileOrigin(m.Origin)}, {Path: "lib/" + m.Module.Slug + ".ts", Content: m.Script, Origin: fileOrigin(m.Origin)}}}
		actual, e := bundle.hash()
		if e != nil || actual != hash {
			return m, ErrConflict
		}
	} else if err != nil {
		return m, dbError(err)
	}
	if json.Unmarshal(raw, &m.Module) != nil || validateModule(&m.Module, m.Module.Slug) != nil {
		return m, ErrInvalid
	}
	return m, nil
}
