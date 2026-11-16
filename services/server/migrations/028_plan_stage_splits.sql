-- A split consumes the original Stage's fixed allocation; retries cannot mint
-- another allocation. Receipts and reservations are immutable, including cancel.
CREATE TABLE plan_stage_splits (
 plan_id uuid NOT NULL REFERENCES plans(id),
 source_stage_id text NOT NULL,
 request_revision integer NOT NULL CHECK(request_revision>0),
 request jsonb NOT NULL,
 source_stage jsonb NOT NULL,
 policy jsonb NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(plan_id,source_stage_id),
 UNIQUE(plan_id,request_revision)
);
CREATE TABLE plan_stage_split_runs (
 plan_id uuid NOT NULL REFERENCES plans(id),
 stage_id text NOT NULL,
 run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
 PRIMARY KEY(plan_id,stage_id)
);
CREATE TRIGGER immutable_plan_stage_splits BEFORE UPDATE OR DELETE ON plan_stage_splits
 FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
CREATE TRIGGER immutable_plan_stage_split_runs BEFORE UPDATE OR DELETE ON plan_stage_split_runs
 FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
