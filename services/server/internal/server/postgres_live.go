package server

import "context"

func (p *Postgres) LiveTarget(ctx context.Context, runID string) (LiveTarget, error) {
	var target LiveTarget
	err := p.DB.QueryRowContext(ctx, `SELECT r.id,t.id,t.workspace_id,COALESCE(r.manager_id,''),
        COALESCE(r.attempt_id::text,''),r.status FROM runs r JOIN tests t ON t.id=r.test_id WHERE r.id=$1`, runID).
		Scan(&target.RunID, &target.TestID, &target.WorkspaceID, &target.ManagerID, &target.AttemptID, &target.Status)
	return target, dbError(err)
}
