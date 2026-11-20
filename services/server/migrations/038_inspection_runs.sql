CREATE TABLE inspection_runs (
    run_id uuid PRIMARY KEY REFERENCES runs(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    environment text NOT NULL,
    target_origin text NOT NULL,
    project_slug text NOT NULL,
    request_id uuid NOT NULL,
    check_key text NOT NULL,
    expected_assertion text NOT NULL,
    observed_assertion text,
    observed_target boolean NOT NULL DEFAULT false,
    terminal_seq bigint UNIQUE,
    UNIQUE (workspace_id, environment, request_id)
);

CREATE INDEX inspection_terminal_feed ON inspection_runs(workspace_id, environment, project_slug, terminal_seq)
    WHERE terminal_seq IS NOT NULL;

CREATE TABLE inspection_terminal_sequence (
    singleton boolean PRIMARY KEY CHECK (singleton),
    value bigint NOT NULL
);
INSERT INTO inspection_terminal_sequence VALUES (true, 0);

CREATE FUNCTION sequence_inspection_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE serial bigint;
BEGIN
    IF EXISTS (SELECT 1 FROM inspection_runs WHERE run_id=NEW.id) THEN
        -- A row lock keeps terminal cursors in commit order, including across
        -- requests that finish in the opposite order from their queue positions.
        UPDATE inspection_terminal_sequence SET value=value+1 WHERE singleton RETURNING value INTO serial;
        UPDATE inspection_runs SET terminal_seq=serial WHERE run_id=NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER inspections_terminal AFTER UPDATE OF status ON runs FOR EACH ROW
    WHEN (OLD.status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted')
          AND NEW.status IN ('succeeded','failed','cancelled','timed_out','interrupted'))
    EXECUTE FUNCTION sequence_inspection_terminal();

CREATE TABLE inspection_report_links (
    run_id uuid PRIMARY KEY REFERENCES inspection_runs(run_id),
    attempt_id uuid NOT NULL,
    report_public_id uuid NOT NULL,
    report_url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
