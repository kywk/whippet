ALTER TABLE agent_browser_leases ADD COLUMN author_run_id uuid REFERENCES external_author_claims(run_id);

UPDATE agent_browser_leases l SET author_run_id=c.run_id
FROM external_author_claims c WHERE c.browser_session_id=l.session_id;

CREATE UNIQUE INDEX agent_browser_leases_one_per_author_run
ON agent_browser_leases(author_run_id) WHERE author_run_id IS NOT NULL;
