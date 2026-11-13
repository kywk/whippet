ALTER TABLE test_versions ADD COLUMN context_revision bigint NOT NULL DEFAULT 0,
 ADD COLUMN published_name text, ADD COLUMN bundle_hash text, ADD COLUMN summary_batch_hash text;
CREATE TABLE plan_summaries (
 run_id uuid PRIMARY KEY REFERENCES runs(id),
 plan_id uuid NOT NULL REFERENCES plans(id),
 batch_hash text NOT NULL,
 output jsonb
);
CREATE TABLE plan_publications (
 plan_id uuid PRIMARY KEY REFERENCES plans(id),
 request_revision integer NOT NULL,
 summary_run_id uuid NOT NULL REFERENCES runs(id),
 result jsonb NOT NULL
);
