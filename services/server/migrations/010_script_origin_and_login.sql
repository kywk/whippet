ALTER TABLE draft_revisions ADD COLUMN script_origin text NOT NULL DEFAULT 'legacy' CHECK(script_origin IN ('ai','manual','legacy'));
ALTER TABLE test_versions ADD COLUMN script_origin text NOT NULL DEFAULT 'legacy' CHECK(script_origin IN ('ai','manual','legacy'));
ALTER TABLE runs ADD COLUMN script_origin text NOT NULL DEFAULT 'legacy' CHECK(script_origin IN ('ai','manual','legacy')),
 ADD COLUMN authorization_revision bigint,
 ADD COLUMN scope_proposal_id uuid,
 ADD COLUMN resolved_role_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(resolved_role_ids)<=10);
ALTER TABLE runs ADD FOREIGN KEY(scope_proposal_id,workspace_id) REFERENCES workspace_proposals(id,workspace_id);
CREATE OR REPLACE FUNCTION whippet_protect_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.test_id,NEW.version_id,NEW.kind,NEW.draft_revision,NEW.script_snapshot,NEW.script_hash,NEW.timeout_ms,
 NEW.created_at,NEW.author_payload,NEW.workspace_settings,NEW.editing_session_id,NEW.workspace_id,NEW.workspace_context,
 NEW.script_origin,NEW.authorization_revision,NEW.scope_proposal_id)
 IS DISTINCT FROM ROW(OLD.id,OLD.test_id,OLD.version_id,OLD.kind,OLD.draft_revision,OLD.script_snapshot,OLD.script_hash,OLD.timeout_ms,
 OLD.created_at,OLD.author_payload,OLD.workspace_settings,OLD.editing_session_id,OLD.workspace_id,OLD.workspace_context,
 OLD.script_origin,OLD.authorization_revision,OLD.scope_proposal_id) THEN
 RAISE EXCEPTION 'run snapshot cannot be changed' USING ERRCODE='23514';END IF;RETURN NEW;
END;$$;
