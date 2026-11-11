CREATE TABLE editing_sessions (
    id uuid PRIMARY KEY,
    test_id uuid NOT NULL REFERENCES tests(id),
    status text NOT NULL CHECK (status IN ('active','discarding','discarded','published')),
    source_version_id uuid,
    conversation_id uuid NOT NULL UNIQUE,
    conversation_summary text,
    context_revision bigint NOT NULL DEFAULT 0 CHECK (context_revision >= 0),
    published_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    UNIQUE (id,test_id),
    FOREIGN KEY (source_version_id,test_id) REFERENCES test_versions(id,test_id),
    FOREIGN KEY (published_version_id,test_id) REFERENCES test_versions(id,test_id)
);
CREATE UNIQUE INDEX editing_sessions_open_idx ON editing_sessions(test_id) WHERE status IN ('active','discarding');

ALTER TABLE conversations DROP CONSTRAINT conversations_test_id_key;
ALTER TABLE conversations ADD CONSTRAINT conversations_id_test_unique UNIQUE(id,test_id);
ALTER TABLE conversations ADD COLUMN editing_session_id uuid UNIQUE;
ALTER TABLE conversations ADD FOREIGN KEY (editing_session_id,test_id) REFERENCES editing_sessions(id,test_id);

-- Only real unpublished changes or unreclaimed editing work stay active. An
-- unchanged post-publication M2 draft is archived without inventing provenance.
INSERT INTO editing_sessions(id,test_id,status,conversation_id,context_revision,published_version_id,closed_at)
SELECT md5('m7-session:'||t.id::text)::uuid,t.id,
    CASE WHEN v.id IS NULL OR dr.script IS DISTINCT FROM v.script OR dr.timeout_ms IS DISTINCT FROM v.timeout_ms
        OR dr.workspace_settings IS DISTINCT FROM v.workspace_settings OR EXISTS (
            SELECT 1 FROM runs r WHERE r.test_id=t.id AND r.kind IN ('author','validation')
            AND (r.status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted') OR NOT r.slot_released))
        THEN 'active' ELSE 'published' END,
    COALESCE(c.id,md5('m7-conversation:'||t.id::text)::uuid),
    (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id),
    NULL,NULL
FROM drafts d JOIN tests t ON t.id=d.test_id
JOIN draft_revisions dr ON dr.test_id=d.test_id AND dr.revision=d.current_revision
LEFT JOIN test_versions v ON v.id=t.published_version_id LEFT JOIN conversations c ON c.test_id=t.id;
UPDATE editing_sessions e SET closed_at=now(),published_version_id=t.published_version_id
FROM tests t WHERE e.test_id=t.id AND e.status='published';
UPDATE conversations c SET editing_session_id=e.id FROM editing_sessions e WHERE e.conversation_id=c.id;
INSERT INTO conversations(id,test_id,editing_session_id)
SELECT e.conversation_id,e.test_id,e.id FROM editing_sessions e WHERE NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=e.conversation_id);
ALTER TABLE editing_sessions ADD FOREIGN KEY (conversation_id,test_id) REFERENCES conversations(id,test_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE drafts ADD COLUMN editing_session_id uuid;
UPDATE drafts d SET editing_session_id=e.id FROM editing_sessions e WHERE e.test_id=d.test_id;
ALTER TABLE drafts ALTER COLUMN editing_session_id SET NOT NULL;
ALTER TABLE drafts ADD FOREIGN KEY(editing_session_id,test_id) REFERENCES editing_sessions(id,test_id);
ALTER TABLE drafts ADD COLUMN summary_run_id uuid REFERENCES runs(id),
    ADD COLUMN summary_description text, ADD COLUMN summary_background text, ADD COLUMN summary_name text;
DELETE FROM drafts d USING editing_sessions e WHERE d.editing_session_id=e.id AND e.status='published';

ALTER TABLE test_versions ADD COLUMN description text, ADD COLUMN background_summary text,
    ADD COLUMN summary_run_id uuid REFERENCES runs(id), ADD COLUMN editing_session_id uuid;
ALTER TABLE test_versions ADD FOREIGN KEY(editing_session_id,test_id) REFERENCES editing_sessions(id,test_id);

ALTER TABLE runs ADD COLUMN editing_session_id uuid;
DROP TRIGGER immutable_run_snapshot ON runs;
UPDATE runs r SET editing_session_id=e.id FROM editing_sessions e WHERE e.test_id=r.test_id AND r.kind IN ('author','validation');
ALTER TABLE runs ADD FOREIGN KEY(editing_session_id,test_id) REFERENCES editing_sessions(id,test_id);
CREATE INDEX runs_editing_session_idx ON runs(editing_session_id);
CREATE OR REPLACE FUNCTION whippet_protect_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.test_id,NEW.version_id,NEW.kind,NEW.draft_revision,NEW.script_snapshot,NEW.script_hash,
           NEW.timeout_ms,NEW.created_at,NEW.author_payload,NEW.workspace_settings,NEW.editing_session_id)
       IS DISTINCT FROM ROW(OLD.id,OLD.test_id,OLD.version_id,OLD.kind,OLD.draft_revision,OLD.script_snapshot,OLD.script_hash,
           OLD.timeout_ms,OLD.created_at,OLD.author_payload,OLD.workspace_settings,OLD.editing_session_id) THEN
        RAISE EXCEPTION 'run snapshot cannot be changed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION whippet_protect_run_snapshot();
