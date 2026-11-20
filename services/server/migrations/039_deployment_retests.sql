CREATE TABLE deployment_retests (
    run_id uuid PRIMARY KEY REFERENCES runs(id),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    test_id uuid NOT NULL REFERENCES tests(id),
    version_id uuid NOT NULL REFERENCES test_versions(id),
    project_slug text NOT NULL,
    environment text NOT NULL,
    deployment_id text NOT NULL,
    artifact_revision text NOT NULL,
    target_origin text NOT NULL,
    proof_path text NOT NULL,
    check_plan jsonb NOT NULL,
    observation jsonb,
    UNIQUE(project_slug,environment,deployment_id,test_id,version_id)
);
