CREATE TABLE draft_revisions (
    test_id uuid NOT NULL REFERENCES tests(id),
    revision integer NOT NULL CHECK (revision > 0),
    script text NOT NULL,
    script_hash text NOT NULL,
    timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (test_id, revision)
);

ALTER TABLE managers DROP CONSTRAINT managers_capacity_check;
ALTER TABLE managers ADD CONSTRAINT managers_capacity_check CHECK (capacity > 0);

ALTER TABLE runs
    ALTER COLUMN version_id DROP NOT NULL,
    ADD COLUMN kind text NOT NULL DEFAULT 'run',
    ADD COLUMN draft_revision integer,
    ADD COLUMN script_hash text,
    ADD CONSTRAINT runs_kind_snapshot_check CHECK (
        (kind='run' AND version_id IS NOT NULL AND draft_revision IS NULL) OR
        (kind='validation' AND version_id IS NULL AND draft_revision IS NOT NULL AND script_hash IS NOT NULL)
    ),
    ADD CONSTRAINT runs_draft_revision_fk FOREIGN KEY (test_id, draft_revision)
        REFERENCES draft_revisions(test_id, revision),
    ADD CONSTRAINT runs_id_test_unique UNIQUE (id, test_id);

CREATE TABLE drafts (
    test_id uuid PRIMARY KEY REFERENCES tests(id),
    current_revision integer NOT NULL,
    validation_run_id uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (test_id, current_revision) REFERENCES draft_revisions(test_id, revision),
    FOREIGN KEY (validation_run_id, test_id) REFERENCES runs(id, test_id)
);

-- Existing M1 seed versions retain their provenance; only new versions require validation.
ALTER TABLE test_versions
    ADD COLUMN source_revision integer NOT NULL DEFAULT 1 CHECK (source_revision > 0),
    ADD COLUMN validation_run_id uuid,
    ADD COLUMN script_hash text,
    ADD CONSTRAINT versions_validation_run_fk FOREIGN KEY (validation_run_id, test_id)
        REFERENCES runs(id, test_id);
CREATE UNIQUE INDEX versions_validation_once_idx ON test_versions(test_id, validation_run_id)
    WHERE validation_run_id IS NOT NULL;

CREATE FUNCTION whippet_reject_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable snapshot cannot be changed' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER immutable_versions BEFORE UPDATE OR DELETE ON test_versions
    FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
CREATE TRIGGER immutable_revisions BEFORE UPDATE OR DELETE ON draft_revisions
    FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();

CREATE FUNCTION whippet_protect_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.test_id, NEW.version_id, NEW.kind, NEW.draft_revision,
           NEW.script_snapshot, NEW.script_hash, NEW.timeout_ms, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.test_id, OLD.version_id, OLD.kind, OLD.draft_revision,
           OLD.script_snapshot, OLD.script_hash, OLD.timeout_ms, OLD.created_at) THEN
        RAISE EXCEPTION 'run snapshot cannot be changed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE ON runs
    FOR EACH ROW EXECUTE FUNCTION whippet_protect_run_snapshot();
