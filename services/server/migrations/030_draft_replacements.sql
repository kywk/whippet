ALTER TABLE messages ADD COLUMN new_test_needed boolean NOT NULL DEFAULT false;
ALTER TABLE editing_sessions ADD COLUMN replacement_test_id uuid REFERENCES tests(id);
