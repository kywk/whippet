ALTER TABLE workspaces ADD COLUMN login_state jsonb NOT NULL DEFAULT '{}';
ALTER TABLE workspace_proposals ADD COLUMN login_state jsonb NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX workspace_secrets_account_version
    ON workspace_secrets(workspace_id, role_id, secret_version);

ALTER TABLE runs
    ADD COLUMN login_verification jsonb,
    ADD COLUMN login_request_id uuid,
    ADD COLUMN login_requested_by text REFERENCES platform_users(id),
    ADD COLUMN login_requested_bootstrap boolean NOT NULL DEFAULT false,
    ADD COLUMN login_attempt_deadline timestamptz,
    ADD COLUMN login_result_receipt bytea,
    ADD COLUMN resolved_account_bindings jsonb NOT NULL DEFAULT '[]';

ALTER TABLE runs DROP CONSTRAINT runs_kind_snapshot_check;
ALTER TABLE runs ADD CONSTRAINT runs_kind_snapshot_check CHECK (
    (test_id IS NOT NULL AND (
        (kind='run' AND version_id IS NOT NULL AND draft_revision IS NULL AND author_payload IS NULL) OR
        (kind='validation' AND version_id IS NULL AND draft_revision IS NOT NULL AND script_hash IS NOT NULL AND author_payload IS NULL) OR
        (kind='author' AND version_id IS NULL AND draft_revision IS NOT NULL AND script_hash IS NOT NULL AND author_payload IS NOT NULL)
    )) OR
    (test_id IS NULL AND kind='author' AND version_id IS NULL AND draft_revision IS NULL AND editing_session_id IS NULL AND
        author_payload IS NOT NULL AND author_payload->>'skillId'='workspace-author' AND author_payload->>'skillVersion'='1') OR
    (test_id IS NULL AND kind='workspace_login_verification' AND version_id IS NULL AND draft_revision IS NULL AND editing_session_id IS NULL AND
        author_payload IS NULL AND script_snapshot='' AND script_origin='legacy' AND scope_proposal_id IS NOT NULL AND
        author_engine='builtin' AND files_snapshot IS NULL AND bundle_hash IS NULL AND bundle_metadata IS NULL)
);

ALTER TABLE runs ADD CONSTRAINT runs_login_verification_fields CHECK (
    (kind='workspace_login_verification' AND login_verification IS NOT NULL AND login_request_id IS NOT NULL) OR
    (kind<>'workspace_login_verification' AND login_verification IS NULL AND login_request_id IS NULL AND
        login_requested_by IS NULL AND NOT login_requested_bootstrap AND login_result_receipt IS NULL AND login_attempt_deadline IS NULL)
);
CREATE UNIQUE INDEX runs_login_request_unique
    ON runs(workspace_id, scope_proposal_id, login_request_id) WHERE login_request_id IS NOT NULL;

CREATE FUNCTION whippet_protect_login_verification_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.login_verification, NEW.login_request_id, NEW.login_requested_by, NEW.login_requested_bootstrap)
       IS DISTINCT FROM ROW(OLD.login_verification, OLD.login_request_id, OLD.login_requested_by, OLD.login_requested_bootstrap) THEN
        RAISE EXCEPTION 'login verification snapshot cannot be changed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_login_verification_snapshot
    BEFORE UPDATE OF login_verification, login_request_id, login_requested_by, login_requested_bootstrap ON runs
    FOR EACH ROW EXECUTE FUNCTION whippet_protect_login_verification_snapshot();
