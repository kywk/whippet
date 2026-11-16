ALTER TABLE workspaces ADD COLUMN author_engine text NOT NULL DEFAULT 'builtin'
    CHECK (author_engine IN ('builtin','external'));
ALTER TABLE runs ADD COLUMN author_engine text NOT NULL DEFAULT 'builtin'
    CHECK (author_engine IN ('builtin','external'));

DO $$
DECLARE old_name text;
BEGIN
    SELECT conname INTO old_name FROM pg_constraint
    WHERE conrelid='runs'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%manager_id IS NULL%'
      AND pg_get_constraintdef(oid) LIKE '%attempt_id IS NULL%';
    IF old_name IS NULL THEN
        RAISE EXCEPTION 'missing run attempt pairing constraint';
    END IF;
    EXECUTE format('ALTER TABLE runs DROP CONSTRAINT %I', old_name);
END;
$$;
ALTER TABLE runs ADD CONSTRAINT runs_manager_id_attempt_id_check CHECK (
    (manager_id IS NULL AND attempt_id IS NULL) OR
    (manager_id IS NOT NULL AND attempt_id IS NOT NULL) OR
    (manager_id IS NULL AND attempt_id IS NOT NULL AND kind='author' AND author_engine='external')
);

CREATE TABLE external_author_claims (
    run_id uuid PRIMARY KEY REFERENCES runs(id),
    attempt_id uuid NOT NULL UNIQUE,
    lease_id uuid NOT NULL UNIQUE,
    token_id uuid NOT NULL REFERENCES agent_tokens(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    request_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('active','submitted','timed_out','cancelled','revoked')),
    expires_at timestamptz NOT NULL,
    deadline_at timestamptz NOT NULL,
    context_revision bigint NOT NULL,
    allowed_tools jsonb NOT NULL,
    browser_session_id uuid REFERENCES agent_browser_leases(session_id),
    submit_id uuid,
    submit_hash bytea,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(token_id,request_id)
);
CREATE UNIQUE INDEX external_author_claims_one_active_token ON external_author_claims(token_id) WHERE state='active';

CREATE TABLE external_author_tool_calls (
    run_id uuid NOT NULL REFERENCES external_author_claims(run_id),
    call_id uuid NOT NULL,
    request_hash bytea NOT NULL,
    state text NOT NULL CHECK (state IN ('sent','pending','replied','unknown')),
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(run_id,call_id)
);

CREATE OR REPLACE FUNCTION whippet_protect_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.test_id, NEW.version_id, NEW.kind, NEW.draft_revision,
           NEW.script_snapshot, NEW.script_hash, NEW.timeout_ms, NEW.created_at, NEW.author_payload, NEW.workspace_settings,
           NEW.editing_session_id, NEW.workspace_id, NEW.workspace_context, NEW.script_origin,
           NEW.authorization_revision, NEW.scope_proposal_id, NEW.author_engine)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.test_id, OLD.version_id, OLD.kind, OLD.draft_revision,
           OLD.script_snapshot, OLD.script_hash, OLD.timeout_ms, OLD.created_at, OLD.author_payload, OLD.workspace_settings,
           OLD.editing_session_id, OLD.workspace_id, OLD.workspace_context, OLD.script_origin,
           OLD.authorization_revision, OLD.scope_proposal_id, OLD.author_engine) THEN
        RAISE EXCEPTION 'run snapshot cannot be changed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
