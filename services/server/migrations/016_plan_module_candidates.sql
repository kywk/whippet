CREATE TABLE plan_module_candidates (
 id uuid PRIMARY KEY,
 plan_id uuid NOT NULL REFERENCES plans(id),
 stage_id text NOT NULL,
 source_run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
 test_id uuid NOT NULL REFERENCES tests(id),
 editing_session_id uuid NOT NULL REFERENCES editing_sessions(id),
 revision integer NOT NULL,
 context_revision bigint NOT NULL,
 bundle_hash text NOT NULL CHECK(bundle_hash ~ '^[0-9a-f]{64}$'),
 UNIQUE(plan_id,stage_id,revision),
 FOREIGN KEY(test_id,revision) REFERENCES draft_revisions(test_id,revision)
);
CREATE TRIGGER immutable_plan_module_candidates BEFORE UPDATE OR DELETE ON plan_module_candidates FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
