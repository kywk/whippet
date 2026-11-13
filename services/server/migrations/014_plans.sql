CREATE TABLE plans (
 id uuid PRIMARY KEY,
 test_id uuid NOT NULL REFERENCES tests(id),
 editing_session_id uuid NOT NULL UNIQUE,
 revision integer NOT NULL CHECK(revision>0),
 base_revision integer NOT NULL CHECK(base_revision>0),
 context_revision bigint NOT NULL CHECK(context_revision>=0),
 status text NOT NULL CHECK(status IN ('draft','confirmed','running','composed','done','stopped')),
 stages jsonb NOT NULL CHECK(jsonb_typeof(stages)='array' AND jsonb_array_length(stages) BETWEEN 1 AND 32),
 validation_run_id uuid REFERENCES runs(id),
 error text,
 FOREIGN KEY(editing_session_id,test_id) REFERENCES editing_sessions(id,test_id)
);
CREATE TABLE plan_operations (
 plan_id uuid NOT NULL REFERENCES plans(id),
 operation text NOT NULL CHECK(operation IN ('confirm','cancel','publish')),
 request_revision integer NOT NULL CHECK(request_revision>0),
 result jsonb NOT NULL,
 PRIMARY KEY(plan_id,operation,request_revision)
);
CREATE TRIGGER immutable_plan_operations BEFORE UPDATE OR DELETE ON plan_operations FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
