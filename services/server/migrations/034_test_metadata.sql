ALTER TABLE tests
    ADD COLUMN metadata_revision integer NOT NULL DEFAULT 1,
    ADD COLUMN tags jsonb CHECK (jsonb_typeof(tags) = 'array');

ALTER TABLE drafts ADD COLUMN summary_suggested_tags jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(summary_suggested_tags) = 'array');

ALTER TABLE test_versions ADD COLUMN suggested_tags jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(suggested_tags) = 'array');

CREATE TABLE test_version_notes (
    version_id uuid PRIMARY KEY REFERENCES test_versions(id),
    description_override text,
    background_summary_override text,
    CHECK (description_override IS NOT NULL OR background_summary_override IS NOT NULL)
);
