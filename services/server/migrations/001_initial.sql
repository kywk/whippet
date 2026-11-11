CREATE TABLE workspaces (
    id uuid PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE tests (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    published_version_id uuid
);

CREATE TABLE test_versions (
    id uuid PRIMARY KEY,
    test_id uuid NOT NULL REFERENCES tests(id),
    version integer NOT NULL CHECK (version > 0),
    script text NOT NULL,
    timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (test_id, version),
    UNIQUE (id, test_id)
);
ALTER TABLE tests ADD CONSTRAINT tests_published_version_fk
    FOREIGN KEY (published_version_id, id) REFERENCES test_versions(id, test_id);

CREATE TABLE managers (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    id text NOT NULL UNIQUE,
    capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 64),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
    id uuid PRIMARY KEY,
    queue_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    test_id uuid NOT NULL REFERENCES tests(id),
    version_id uuid NOT NULL,
    script_snapshot text NOT NULL,
    timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued', 'dispatched', 'running', 'collecting', 'succeeded', 'failed',
        'cancelling', 'cancelled', 'timed_out', 'interrupted'
    )),
    manager_id text REFERENCES managers(id),
    attempt_id uuid UNIQUE,
    acknowledged_at timestamptz,
    slot_released boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    error text NOT NULL DEFAULT '',
    FOREIGN KEY (version_id, test_id) REFERENCES test_versions(id, test_id),
    CHECK ((manager_id IS NULL) = (attempt_id IS NULL)),
    CHECK (slot_released OR attempt_id IS NOT NULL)
);
CREATE INDEX runs_fifo_idx ON runs(queue_seq) WHERE status = 'queued';
CREATE INDEX runs_test_idx ON runs(test_id, queue_seq DESC);
CREATE INDEX runs_manager_slots_idx ON runs(manager_id) WHERE NOT slot_released;

CREATE TABLE run_events (
    run_id uuid NOT NULL REFERENCES runs(id),
    event_id text NOT NULL,
    attempt_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('started', 'log')),
    message text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, event_id)
);

CREATE TABLE artifacts (
    run_id uuid NOT NULL REFERENCES runs(id),
    name text NOT NULL CHECK (name IN ('report.html', 'results.json')),
    attempt_id uuid NOT NULL,
    storage_key text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    sha256 text NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, name)
);
