ALTER TABLE tests ADD COLUMN kind text NOT NULL DEFAULT 'test' CHECK(kind IN ('test','module','usecase')),
 ADD COLUMN slug text,
 ADD CONSTRAINT module_slug CHECK ((kind='module' AND slug IS NOT NULL AND slug ~ '^[a-z][a-z0-9-]{0,63}$') OR (kind<>'module' AND slug IS NULL)),
 ADD CONSTRAINT workspace_module_slug UNIQUE(workspace_id,slug);
CREATE FUNCTION whippet_protect_test_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.kind,NEW.slug,NEW.workspace_id) IS DISTINCT FROM ROW(OLD.kind,OLD.slug,OLD.workspace_id) THEN
  RAISE EXCEPTION 'test kind, workspace and slug are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_test_kind BEFORE UPDATE ON tests FOR EACH ROW EXECUTE FUNCTION whippet_protect_test_kind();
ALTER TABLE draft_revisions ADD COLUMN module jsonb, ADD COLUMN stages jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(stages)='array');
ALTER TABLE test_versions ADD COLUMN module jsonb, ADD COLUMN stages jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(stages)='array');
CREATE TABLE version_dependencies (
 version_id uuid NOT NULL REFERENCES test_versions(id),
 module_version_id uuid NOT NULL REFERENCES test_versions(id),
 PRIMARY KEY(version_id,module_version_id), CHECK(version_id<>module_version_id)
);
CREATE FUNCTION whippet_check_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_kind text; target_kind text; source_workspace uuid; target_workspace uuid;
BEGIN
 -- Dependencies are created only in the version's publication transaction.
 -- UPDATE/DELETE guards alone would still permit appending to an old version.
 IF NOT EXISTS(SELECT 1 FROM test_versions v WHERE v.id=NEW.version_id AND v.xmin::text=pg_current_xact_id()::text) THEN
  RAISE EXCEPTION 'dependencies must be inserted with their source version' USING ERRCODE='23514';
 END IF;
 SELECT t.kind,t.workspace_id INTO source_kind,source_workspace FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.id=NEW.version_id;
 SELECT t.kind,t.workspace_id INTO target_kind,target_workspace FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.id=NEW.module_version_id;
 IF source_kind IS DISTINCT FROM 'usecase' OR target_kind IS DISTINCT FROM 'module' OR source_workspace IS DISTINCT FROM target_workspace THEN
  RAISE EXCEPTION 'dependency must be a Module in the same Workspace' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM version_dependencies d JOIN test_versions existing ON existing.id=d.module_version_id
 JOIN test_versions incoming ON incoming.id=NEW.module_version_id WHERE d.version_id=NEW.version_id AND existing.test_id=incoming.test_id AND existing.id<>incoming.id) THEN
  RAISE EXCEPTION 'one module version per bundle' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER valid_dependency BEFORE INSERT ON version_dependencies FOR EACH ROW EXECUTE FUNCTION whippet_check_dependency();
CREATE TRIGGER immutable_dependencies BEFORE UPDATE OR DELETE ON version_dependencies FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();

-- Read-tool retries are memoized separately from future candidate/queue tools.
CREATE TABLE harness_history_calls (
 run_id uuid NOT NULL REFERENCES runs(id), attempt_id uuid NOT NULL, call_id uuid NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(run_id,attempt_id,call_id)
);
