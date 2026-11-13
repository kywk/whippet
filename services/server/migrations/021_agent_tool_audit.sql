CREATE TABLE agent_tool_audit (
    id uuid PRIMARY KEY,
    token_id uuid NOT NULL REFERENCES agent_tokens(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    tool_name text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('allowed','denied','rate_limited','failed')),
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_tool_audit_workspace_idx ON agent_tool_audit(workspace_id,occurred_at DESC,id DESC);
