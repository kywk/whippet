ALTER TABLE runs ADD COLUMN author_partial jsonb,
 ADD COLUMN author_partial_context_revision bigint,
 ADD CONSTRAINT author_partial_shape CHECK(author_partial IS NULL OR (kind='author' AND test_id IS NOT NULL AND jsonb_typeof(author_partial)='object'));
CREATE TABLE author_continuations (
 source_run_id uuid PRIMARY KEY REFERENCES runs(id),
 run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
 editing_session_id uuid NOT NULL REFERENCES editing_sessions(id),
 revision integer NOT NULL CHECK(revision>0)
);
CREATE TRIGGER immutable_author_continuations BEFORE UPDATE OR DELETE ON author_continuations
 FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
CREATE FUNCTION whippet_protect_author_partial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.author_partial,NEW.author_partial_context_revision) IS DISTINCT FROM ROW(OLD.author_partial,OLD.author_partial_context_revision)
 AND (OLD.status IN ('succeeded','failed','cancelled','timed_out','interrupted') OR OLD.author_partial IS NOT NULL) THEN
  RAISE EXCEPTION 'author partial is immutable after completion' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_author_partial BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION whippet_protect_author_partial();
