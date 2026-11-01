CREATE TABLE payment_review_lab_notes (
 id UUID PRIMARY KEY,attempt_id UUID NOT NULL,warehouse_id UUID NOT NULL,
 actor_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,actor_name VARCHAR(120) NOT NULL,
 key UUID NOT NULL,note VARCHAR(500) NOT NULL CHECK(char_length(btrim(note)) BETWEEN 1 AND 500),
 evidence VARCHAR(16) NOT NULL CHECK(evidence IN ('NONE','UNKNOWN','CLOSED','SUCCEEDED','CONFLICT')),
 attempt_version INTEGER NOT NULL CHECK(attempt_version>=0),
 task_state VARCHAR(16) CHECK(task_state IN ('RETRY','LEASED','DONE','EXHAUSTED')),job_version INTEGER CHECK(job_version>=0),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((task_state IS NULL)=(job_version IS NULL)),
 FOREIGN KEY(attempt_id,warehouse_id) REFERENCES payment_attempt_labs(id,warehouse_id) ON DELETE RESTRICT,
 UNIQUE(attempt_id,actor_id,key)
);
CREATE INDEX payment_review_lab_notes_history_idx ON payment_review_lab_notes(attempt_id,created_at,id);
CREATE TRIGGER payment_review_lab_notes_immutable BEFORE UPDATE OR DELETE ON payment_review_lab_notes FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_review_lab_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; j record;
BEGIN
 SELECT * INTO a FROM payment_attempt_labs WHERE id=NEW.attempt_id FOR SHARE;
 SELECT * INTO j FROM payment_query_lab_jobs WHERE attempt_id=NEW.attempt_id FOR SHARE;
 IF a.warehouse_id IS DISTINCT FROM NEW.warehouse_id OR a.version IS DISTINCT FROM NEW.attempt_version OR a.evidence IS DISTINCT FROM NEW.evidence OR j.version IS DISTINCT FROM NEW.job_version OR j.state IS DISTINCT FROM NEW.task_state THEN RAISE EXCEPTION 'Review snapshot must match locked attempt and task'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_review_lab_note_snapshot BEFORE INSERT ON payment_review_lab_notes FOR EACH ROW EXECUTE FUNCTION yumi_review_lab_snapshot();
