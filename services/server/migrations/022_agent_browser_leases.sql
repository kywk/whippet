CREATE TABLE agent_browser_leases (
    session_id uuid PRIMARY KEY,
    lease_id uuid NOT NULL UNIQUE,
    request_id uuid NOT NULL,
    token_id uuid NOT NULL REFERENCES agent_tokens(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    manager_id text NOT NULL REFERENCES managers(id),
    manager_epoch uuid NOT NULL,
    registry_version text NOT NULL,
    registry_sha256 text NOT NULL,
    workspace_context jsonb NOT NULL,
    authorization_revision bigint NOT NULL,
    state text NOT NULL CHECK (state IN ('opening','ready','closing','reclaim_pending','closed')),
    reclaimed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    deadline_at timestamptz NOT NULL,
    last_activity_at timestamptz,
    close_sent_at timestamptz,
    UNIQUE (token_id, request_id),
    CHECK ((state = 'closed') = reclaimed)
);
CREATE UNIQUE INDEX agent_browser_leases_one_live_token
    ON agent_browser_leases(token_id) WHERE NOT reclaimed;
CREATE INDEX agent_browser_leases_manager_live
    ON agent_browser_leases(manager_id) WHERE NOT reclaimed;

CREATE TABLE agent_browser_calls (
    session_id uuid NOT NULL REFERENCES agent_browser_leases(session_id),
    call_id uuid NOT NULL,
    request_hash bytea NOT NULL,
    state text NOT NULL CHECK (state IN ('sent','replied','unknown')),
    reply_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id,call_id)
);
CREATE UNIQUE INDEX agent_browser_calls_one_inflight
    ON agent_browser_calls(session_id) WHERE state = 'sent';
