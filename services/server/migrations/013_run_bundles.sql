ALTER TABLE runs ADD COLUMN files_snapshot jsonb,
 ADD COLUMN bundle_hash text,
 ADD COLUMN bundle_metadata jsonb,
 ADD CONSTRAINT run_bundle_complete CHECK (
 (files_snapshot IS NULL AND bundle_hash IS NULL AND bundle_metadata IS NULL) OR
 (files_snapshot IS NOT NULL AND jsonb_typeof(files_snapshot)='array' AND jsonb_array_length(files_snapshot) BETWEEN 1 AND 64
  AND bundle_hash IS NOT NULL AND bundle_hash ~ '^[a-f0-9]{64}$' AND bundle_metadata IS NOT NULL AND jsonb_typeof(bundle_metadata)='object' AND kind<>'author')
 );
CREATE FUNCTION whippet_protect_run_bundle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.files_snapshot,NEW.bundle_hash,NEW.bundle_metadata) IS DISTINCT FROM ROW(OLD.files_snapshot,OLD.bundle_hash,OLD.bundle_metadata) THEN
 RAISE EXCEPTION 'run bundle is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_run_bundle BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION whippet_protect_run_bundle();
