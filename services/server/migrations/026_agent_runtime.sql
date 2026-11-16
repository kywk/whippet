-- Runtime selection is nonsecret control-plane policy, separate from site scope.
ALTER TABLE workspaces ADD COLUMN agent_runtime jsonb NOT NULL
  DEFAULT '{"profileId":"builtin","skillProfiles":{}}'::jsonb;
