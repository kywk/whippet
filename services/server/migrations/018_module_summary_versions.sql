CREATE TABLE module_version_candidates (
 id uuid PRIMARY KEY,
 test_id uuid NOT NULL REFERENCES tests(id),
 editing_session_id uuid NOT NULL REFERENCES editing_sessions(id),
 revision integer NOT NULL,
 bundle_hash text NOT NULL CHECK(bundle_hash ~ '^[0-9a-f]{64}$'),
 UNIQUE(test_id,editing_session_id,revision,bundle_hash),
 FOREIGN KEY(test_id,revision) REFERENCES draft_revisions(test_id,revision)
);
CREATE TRIGGER immutable_module_version_candidates BEFORE UPDATE OR DELETE ON module_version_candidates FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
