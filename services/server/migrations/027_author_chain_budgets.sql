-- One immutable allocation per controlled continuation; legacy Runs stay untouched.
CREATE TABLE author_chain_budgets (
 run_id uuid PRIMARY KEY REFERENCES runs(id),
 root_run_id uuid NOT NULL REFERENCES runs(id),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
 max_runs integer NOT NULL CHECK(max_runs=3),
 budget_limit jsonb NOT NULL CHECK(jsonb_typeof(budget_limit)='object'),
 spent_before jsonb NOT NULL CHECK(jsonb_typeof(spent_before)='object'),
 UNIQUE(root_run_id,ordinal),
 CHECK((ordinal=1)=(run_id=root_run_id))
);
CREATE TRIGGER immutable_author_chain_budgets BEFORE UPDATE OR DELETE ON author_chain_budgets
 FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();
