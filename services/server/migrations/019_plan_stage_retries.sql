CREATE TABLE plan_stage_retries (
 plan_id uuid NOT NULL REFERENCES plans(id),
 request_plan_revision integer NOT NULL CHECK(request_plan_revision>0),
 stage_id text NOT NULL,
 request jsonb NOT NULL,
 source_author_run_id uuid NOT NULL REFERENCES runs(id),
 source_validation_run_id uuid REFERENCES runs(id),
 new_author_run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
 result jsonb NOT NULL,
 PRIMARY KEY(plan_id,request_plan_revision)
);
CREATE TRIGGER immutable_plan_stage_retries BEFORE UPDATE OR DELETE ON plan_stage_retries FOR EACH ROW EXECUTE FUNCTION whippet_reject_snapshot_mutation();

-- Historical absence of a cancellation marker is not evidence of no cancel.
ALTER TABLE runs ADD COLUMN cancel_requested boolean;
UPDATE runs SET cancel_requested=true WHERE status IN ('cancelling','cancelled');
ALTER TABLE runs ALTER COLUMN cancel_requested SET DEFAULT false;
CREATE FUNCTION whippet_preserve_cancel_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('cancelling','cancelled') THEN
  NEW.cancel_requested := true;
 ELSIF TG_OP = 'UPDATE' THEN
  IF OLD.cancel_requested IS TRUE THEN
   NEW.cancel_requested := true;
  ELSIF OLD.cancel_requested IS NULL THEN
   NEW.cancel_requested := NULL;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_run_cancel_history BEFORE INSERT OR UPDATE ON runs
 FOR EACH ROW EXECUTE FUNCTION whippet_preserve_cancel_history();
