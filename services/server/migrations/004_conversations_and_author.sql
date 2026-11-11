CREATE TABLE conversations (
    id uuid PRIMARY KEY,
    test_id uuid NOT NULL UNIQUE REFERENCES tests(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
    id uuid PRIMARY KEY,
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    conversation_id uuid NOT NULL REFERENCES conversations(id),
    role text NOT NULL CHECK (role IN ('user','assistant')),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    run_id uuid REFERENCES runs(id),
    base_revision integer CHECK (base_revision > 0),
    applied_revision integer CHECK (applied_revision > 0),
    proposed_script text,
    validation_run_id uuid REFERENCES runs(id),
    UNIQUE (run_id, role)
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, sequence);

ALTER TABLE runs
    ADD COLUMN author_payload jsonb,
    ADD COLUMN author_reported_status text CHECK (author_reported_status IN ('succeeded','failed','timed_out','cancelled')),
    DROP CONSTRAINT runs_kind_snapshot_check;
ALTER TABLE runs ADD CONSTRAINT runs_kind_snapshot_check CHECK (
    (kind='run' AND version_id IS NOT NULL AND draft_revision IS NULL AND author_payload IS NULL) OR
    (kind='validation' AND version_id IS NULL AND draft_revision IS NOT NULL AND script_hash IS NOT NULL AND author_payload IS NULL) OR
    (kind='author' AND version_id IS NULL AND draft_revision IS NOT NULL AND script_hash IS NOT NULL AND author_payload IS NOT NULL)
);
CREATE UNIQUE INDEX runs_one_active_author_idx ON runs(test_id) WHERE kind='author'
    AND status IN ('queued','dispatched','running','collecting','cancelling');

ALTER TABLE artifacts DROP CONSTRAINT artifacts_name_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_name_check CHECK (name IN ('report.html','results.json','author.json'));

CREATE OR REPLACE FUNCTION whippet_protect_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.test_id, NEW.version_id, NEW.kind, NEW.draft_revision,
           NEW.script_snapshot, NEW.script_hash, NEW.timeout_ms, NEW.created_at, NEW.author_payload)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.test_id, OLD.version_id, OLD.kind, OLD.draft_revision,
           OLD.script_snapshot, OLD.script_hash, OLD.timeout_ms, OLD.created_at, OLD.author_payload) THEN
        RAISE EXCEPTION 'run snapshot cannot be changed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
