CREATE TABLE new_test_reviews (
    editing_session_id uuid PRIMARY KEY REFERENCES editing_sessions(id),
    id uuid NOT NULL UNIQUE,
    matched_test_id uuid REFERENCES tests(id),
    request_text text,
    created_at timestamptz NOT NULL DEFAULT now(),
    continued_run_id uuid REFERENCES runs(id),
    CHECK ((matched_test_id IS NULL) = (request_text IS NULL)),
    CHECK (continued_run_id IS NULL OR matched_test_id IS NULL)
);
