CREATE TABLE platform_users (
    id text PRIMARY KEY,
    display_name text NOT NULL,
    site_role text NOT NULL CHECK (site_role IN ('superadmin','site_admin','none'))
);

INSERT INTO platform_users(id, display_name, site_role) VALUES
    ('dev-admin', 'Super Admin', 'superadmin'),
    ('dev-site-admin', 'Site Admin', 'site_admin'),
    ('dev-workspace-admin', 'Workspace Admin', 'none'),
    ('dev-qa', 'QA User', 'none');

CREATE TABLE workspace_memberships (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES platform_users(id),
    role text NOT NULL CHECK (role IN ('workspace_admin','qa')),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_memberships_by_user ON workspace_memberships(user_id, workspace_id);

INSERT INTO workspace_memberships(workspace_id, user_id, role)
SELECT w.id, defaults.user_id, defaults.role
FROM workspaces w
CROSS JOIN (VALUES ('dev-workspace-admin', 'workspace_admin'), ('dev-qa', 'qa'))
    AS defaults(user_id, role);
