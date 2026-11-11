package server

import "context"

func (p *Postgres) LiveTarget(ctx context.Context, runID string) (LiveTarget, error) {
	var target LiveTarget
	err := p.DB.QueryRowContext(ctx, `SELECT r.id,COALESCE(r.test_id::text,''),r.workspace_id,COALESCE(r.manager_id,''),
        COALESCE(r.attempt_id::text,''),r.status FROM runs r WHERE r.id=$1 AND (r.kind<>'author' OR r.author_payload->'allowedTools' ?| ARRAY['browser_navigate','browser_snapshot','browser_click','browser_fill','browser_login'])`, runID).
		Scan(&target.RunID, &target.TestID, &target.WorkspaceID, &target.ManagerID, &target.AttemptID, &target.Status)
	return target, dbError(err)
}
