-- Root authority and successful manual resumptions are immutable. Split roots
-- remain in plan_stage_split_runs; a child never reserves that allocation again.
CREATE TABLE plan_stage_author_bindings (
 run_id uuid PRIMARY KEY REFERENCES runs(id),
 plan_id uuid NOT NULL REFERENCES plans(id),
 stage_id text NOT NULL,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object')
);
CREATE TABLE plan_stage_continuations (
 source_run_id uuid PRIMARY KEY REFERENCES runs(id),
 run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
 plan_id uuid NOT NULL REFERENCES plans(id),
 stage_id text NOT NULL,
 request_plan_revision integer NOT NULL CHECK(request_plan_revision>0),
 request jsonb NOT NULL,
 result jsonb NOT NULL,
 UNIQUE(plan_id,request_plan_revision)
);
CREATE TRIGGER immutable_plan_stage_author_bindings BEFORE UPDATE OR DELETE ON plan_stage_author_bindings
 FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
CREATE TRIGGER immutable_plan_stage_continuations BEFORE UPDATE OR DELETE ON plan_stage_continuations
 FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
