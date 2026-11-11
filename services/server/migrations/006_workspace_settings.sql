ALTER TABLE workspaces ADD COLUMN settings jsonb NOT NULL DEFAULT
    '{"revision":1,"sites":[],"defaultTestUrl":"","timeoutMs":60000}'::jsonb;

ALTER TABLE draft_revisions ADD COLUMN workspace_settings jsonb;
ALTER TABLE test_versions ADD COLUMN workspace_settings jsonb;
ALTER TABLE runs ADD COLUMN workspace_settings jsonb;

-- Backfill only the new column, preserving each historical timeout and script.
-- Migration runs atomically under the startup advisory lock; restore protections
-- before commit, including the new immutable snapshot column.
DROP TRIGGER immutable_revisions ON draft_revisions;
DROP TRIGGER immutable_versions ON test_versions;
DROP TRIGGER immutable_run_snapshot ON runs;

UPDATE draft_revisions SET workspace_settings = jsonb_build_object(
    'revision',1,'sites','[]'::jsonb,'defaultTestUrl','','timeoutMs',COALESCE(timeout_ms,60000));
UPDATE test_versions SET workspace_settings = jsonb_build_object(
    'revision',1,'sites','[]'::jsonb,'defaultTestUrl','','timeoutMs',COALESCE(timeout_ms,60000));
UPDATE runs r SET workspace_settings = jsonb_build_object(
    'revision',1,'sites','[]'::jsonb,'defaultTestUrl','','timeoutMs',
    CASE WHEN r.kind='author' THEN COALESCE((SELECT dr.timeout_ms FROM draft_revisions dr
        WHERE dr.test_id=r.test_id AND dr.revision=r.draft_revision),60000)
    ELSE COALESCE(r.timeout_ms,60000) END);

ALTER TABLE draft_revisions ALTER COLUMN workspace_settings SET NOT NULL;
ALTER TABLE test_versions ALTER COLUMN workspace_settings SET NOT NULL;
ALTER TABLE runs ALTER COLUMN workspace_settings SET NOT NULL;

CREATE TRIGGER immutable_versions BEFORE UPDATE OR DELETE ON test_versions
    FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
CREATE TRIGGER immutable_revisions BEFORE UPDATE OR DELETE ON draft_revisions
    FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();

CREATE OR REPLACE FUNCTION whippet_protect_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.test_id, NEW.version_id, NEW.kind, NEW.draft_revision,
           NEW.script_snapshot, NEW.script_hash, NEW.timeout_ms, NEW.created_at, NEW.author_payload, NEW.workspace_settings)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.test_id, OLD.version_id, OLD.kind, OLD.draft_revision,
           OLD.script_snapshot, OLD.script_hash, OLD.timeout_ms, OLD.created_at, OLD.author_payload, OLD.workspace_settings) THEN
        RAISE EXCEPTION 'run snapshot cannot be changed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE ON runs
    FOR EACH ROW EXECUTE FUNCTION whippet_protect_run_snapshot();
