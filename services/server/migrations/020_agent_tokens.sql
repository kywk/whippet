CREATE TABLE agent_tokens (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    last_used_at timestamptz,
    CHECK (char_length(name) BETWEEN 1 AND 100)
);
CREATE INDEX agent_tokens_workspace_idx ON agent_tokens(workspace_id, created_at DESC);
