ALTER TABLE tests
 ADD COLUMN archived_at timestamptz,
 ADD CONSTRAINT archived_tests_are_hidden CHECK (archived_at IS NULL OR deleted_at IS NOT NULL);

CREATE INDEX tests_archived_workspace_idx ON tests(workspace_id, id) WHERE archived_at IS NOT NULL;
