ALTER TABLE workspaces ADD COLUMN lifecycle text NOT NULL DEFAULT 'needs_confirmation' CHECK(lifecycle IN ('draft','needs_confirmation','active')),
 ADD COLUMN canonical_config jsonb, ADD COLUMN authorization_revision bigint NOT NULL DEFAULT 0,
 ADD COLUMN scope_status text NOT NULL DEFAULT 'unconfirmed' CHECK(scope_status IN ('unconfirmed','confirmed','revoking')),
 ADD COLUMN current_proposal_id uuid;
ALTER TABLE tests ADD CONSTRAINT tests_id_workspace_unique UNIQUE(id,workspace_id);
ALTER TABLE conversations ADD COLUMN workspace_id uuid REFERENCES workspaces(id),
 ADD COLUMN owner_type text NOT NULL DEFAULT 'test' CHECK(owner_type IN ('test','workspace')),
 ADD COLUMN context_revision bigint NOT NULL DEFAULT 0 CHECK(context_revision>=0), ADD COLUMN conversation_summary text;
UPDATE conversations c SET workspace_id=t.workspace_id FROM tests t WHERE t.id=c.test_id;
ALTER TABLE conversations ALTER COLUMN workspace_id SET NOT NULL, ALTER COLUMN test_id DROP NOT NULL;
ALTER TABLE conversations ADD FOREIGN KEY(test_id,workspace_id) REFERENCES tests(id,workspace_id),
 ADD CONSTRAINT conversations_owner_check CHECK((owner_type='workspace' AND test_id IS NULL AND editing_session_id IS NULL) OR (owner_type='test' AND test_id IS NOT NULL));
CREATE UNIQUE INDEX conversations_workspace_setup_idx ON conversations(workspace_id) WHERE owner_type='workspace';
INSERT INTO conversations(id,workspace_id,owner_type) SELECT md5('m8-workspace-conversation:'||id::text)::uuid,id,'workspace' FROM workspaces;

ALTER TABLE runs ADD COLUMN workspace_id uuid REFERENCES workspaces(id), ADD COLUMN workspace_context jsonb;
DROP TRIGGER immutable_run_snapshot ON runs;
UPDATE runs r SET workspace_id=t.workspace_id FROM tests t WHERE r.test_id=t.id;
ALTER TABLE runs ALTER COLUMN workspace_id SET NOT NULL, ALTER COLUMN test_id DROP NOT NULL;
ALTER TABLE runs ADD FOREIGN KEY(test_id,workspace_id) REFERENCES tests(id,workspace_id);
ALTER TABLE runs DROP CONSTRAINT runs_kind_snapshot_check;
ALTER TABLE runs ADD CONSTRAINT runs_kind_snapshot_check CHECK (
 (test_id IS NOT NULL AND ((kind='run' AND version_id IS NOT NULL AND draft_revision IS NULL AND author_payload IS NULL) OR
 (kind='validation' AND version_id IS NULL AND draft_revision IS NOT NULL AND script_hash IS NOT NULL AND author_payload IS NULL) OR
 (kind='author' AND version_id IS NULL AND draft_revision IS NOT NULL AND script_hash IS NOT NULL AND author_payload IS NOT NULL))) OR
 (test_id IS NULL AND kind='author' AND version_id IS NULL AND draft_revision IS NULL AND editing_session_id IS NULL AND
 author_payload IS NOT NULL AND author_payload->>'skillId'='workspace-author' AND author_payload->>'skillVersion'='1'));
CREATE UNIQUE INDEX runs_workspace_author_active_idx ON runs(workspace_id) WHERE test_id IS NULL AND kind='author' AND status IN ('queued','dispatched','running','collecting','cancelling');
ALTER TABLE draft_revisions ADD COLUMN workspace_context jsonb;
ALTER TABLE test_versions ADD COLUMN workspace_context jsonb;

CREATE TABLE workspace_roles (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id),
 secret_ref uuid,secret_version integer,configured boolean NOT NULL DEFAULT false,
 UNIQUE(id,workspace_id),CHECK((secret_ref IS NULL)=(secret_version IS NULL))
);
CREATE TABLE workspace_secrets (
 workspace_id uuid NOT NULL,role_id uuid NOT NULL,secret_ref uuid NOT NULL,secret_version integer NOT NULL CHECK(secret_version>0),
 nonce bytea NOT NULL,ciphertext bytea NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(secret_ref,secret_version),FOREIGN KEY(role_id,workspace_id) REFERENCES workspace_roles(id,workspace_id)
);
CREATE TABLE workspace_proposals (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id),conversation_id uuid NOT NULL REFERENCES conversations(id),
 source_run_id uuid NOT NULL UNIQUE REFERENCES runs(id),base_revision integer NOT NULL,context_revision bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','applied','cancelled','stale','superseded')),
 content jsonb NOT NULL,scope_hash text NOT NULL,scope_confirmed boolean NOT NULL DEFAULT false,
 invalidation_reason text,applied_revision integer,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,workspace_id)
);
ALTER TABLE workspaces ADD FOREIGN KEY(current_proposal_id,id) REFERENCES workspace_proposals(id,workspace_id);
CREATE OR REPLACE FUNCTION whippet_protect_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.test_id,NEW.version_id,NEW.kind,NEW.draft_revision,NEW.script_snapshot,NEW.script_hash,NEW.timeout_ms,
 NEW.created_at,NEW.author_payload,NEW.workspace_settings,NEW.editing_session_id,NEW.workspace_id,NEW.workspace_context)
 IS DISTINCT FROM ROW(OLD.id,OLD.test_id,OLD.version_id,OLD.kind,OLD.draft_revision,OLD.script_snapshot,OLD.script_hash,OLD.timeout_ms,
 OLD.created_at,OLD.author_payload,OLD.workspace_settings,OLD.editing_session_id,OLD.workspace_id,OLD.workspace_context) THEN
 RAISE EXCEPTION 'run snapshot cannot be changed' USING ERRCODE='23514';END IF;RETURN NEW;
END;$$;
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION whippet_protect_run_snapshot();
