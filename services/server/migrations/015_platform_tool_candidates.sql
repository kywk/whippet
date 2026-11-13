CREATE TABLE platform_tool_calls (
 run_id uuid NOT NULL REFERENCES runs(id),
 attempt_id uuid NOT NULL,
 call_id uuid NOT NULL,
 request_hash text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(run_id,attempt_id,call_id)
);
CREATE TABLE plan_candidates (
 id uuid PRIMARY KEY,
 sequence bigserial UNIQUE NOT NULL,
 run_id uuid NOT NULL REFERENCES runs(id),
 attempt_id uuid NOT NULL,
 editing_session_id uuid NOT NULL REFERENCES editing_sessions(id),
 base_revision integer NOT NULL,
 context_revision bigint NOT NULL,
 content_hash text NOT NULL,
 stages jsonb NOT NULL
);
CREATE TABLE module_validation_requests (
 source_run_id uuid PRIMARY KEY REFERENCES runs(id),
 test_id uuid NOT NULL REFERENCES tests(id),
 editing_session_id uuid NOT NULL REFERENCES editing_sessions(id),
 revision integer NOT NULL,
 context_revision bigint NOT NULL,
 validation_run_id uuid REFERENCES runs(id),
 resolved boolean NOT NULL DEFAULT false
);
