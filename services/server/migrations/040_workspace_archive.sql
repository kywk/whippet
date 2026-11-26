ALTER TABLE workspaces
 ADD COLUMN management_name text,
 ADD COLUMN management_revision integer NOT NULL DEFAULT 1 CHECK (management_revision > 0),
 ADD COLUMN archive_status text NOT NULL DEFAULT 'active' CHECK (archive_status IN ('active','archiving','archived')),
 ADD COLUMN archive_mode text CHECK (archive_mode IN ('drain','cancel')),
 ADD COLUMN archive_started_at timestamptz,
 ADD COLUMN archived_at timestamptz,
 ADD CONSTRAINT workspace_archive_fields CHECK (
  (archive_status='active' AND archive_mode IS NULL AND archive_started_at IS NULL AND archived_at IS NULL) OR
  (archive_status='archiving' AND archive_mode IS NOT NULL AND archive_started_at IS NOT NULL AND archived_at IS NULL) OR
  (archive_status='archived' AND archive_mode IS NOT NULL AND archive_started_at IS NOT NULL AND archived_at IS NOT NULL)
 );

UPDATE platform_users SET display_name='Site Manager' WHERE id='dev-site-admin' AND display_name='Site Admin';

CREATE INDEX runs_workspace_unfinished_idx ON runs(workspace_id)
 WHERE status IN ('queued','dispatched','running','collecting','cancelling') OR NOT slot_released;
CREATE INDEX agent_browser_leases_workspace_live_idx ON agent_browser_leases(workspace_id) WHERE NOT reclaimed;
CREATE INDEX external_author_claims_workspace_active_idx ON external_author_claims(workspace_id) WHERE state='active';

CREATE TABLE site_management_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_kind text NOT NULL CHECK (actor_kind IN ('user','bootstrap','manager','agent_token','system')),
 actor_id text NOT NULL,
 action text NOT NULL,
 target_type text NOT NULL,
 target_id text NOT NULL,
 workspace_id uuid,
 outcome text NOT NULL CHECK (outcome IN ('succeeded','accepted','denied','failed')),
 code text,
 request_id uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
