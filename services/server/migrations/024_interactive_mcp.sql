CREATE TABLE agent_interactive_operations (
    token_id uuid NOT NULL REFERENCES agent_tokens(id),
    tool_name text NOT NULL CHECK (tool_name IN ('draft_create','author_start','validation_request')),
    request_id uuid NOT NULL,
    request_hash bytea NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (token_id, tool_name, request_id)
);

CREATE TABLE agent_draft_sources (
    test_id uuid PRIMARY KEY REFERENCES tests(id),
    token_id uuid NOT NULL REFERENCES agent_tokens(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plans ADD COLUMN script_origin text NOT NULL DEFAULT 'manual'
    CHECK (script_origin IN ('manual','ai'));
