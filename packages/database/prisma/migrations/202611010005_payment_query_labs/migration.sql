BEGIN;
ALTER TABLE payment_attempt_labs ADD UNIQUE(id,warehouse_id);
CREATE TABLE payment_query_lab_jobs (
 id UUID PRIMARY KEY,attempt_id UUID NOT NULL UNIQUE,warehouse_id UUID NOT NULL,
 state VARCHAR(16) NOT NULL DEFAULT 'RETRY' CHECK(state IN ('RETRY','LEASED','DONE','EXHAUSTED')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 next_run_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,lease_token UUID,lease_until TIMESTAMPTZ(3),created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(attempt_id,warehouse_id),
 FOREIGN KEY(attempt_id,warehouse_id) REFERENCES payment_attempt_labs(id,warehouse_id) ON DELETE RESTRICT,
 CHECK((state='LEASED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND attempts>0) OR (state<>'LEASED' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK(state<>'EXHAUSTED' OR attempts=3)
);
CREATE INDEX payment_query_lab_due_idx ON payment_query_lab_jobs(state,next_run_at);
CREATE TABLE payment_query_lab_events (
 id UUID PRIMARY KEY,job_id UUID NOT NULL REFERENCES payment_query_lab_jobs(id) ON DELETE RESTRICT,key UUID NOT NULL,
 reason VARCHAR(32) NOT NULL CHECK(reason IN ('SCHEDULED','CLAIMED','LEASE_RECOVERED','RETRY_UNKNOWN','EXHAUSTED_UNKNOWN','STOPPED_KNOWN','EVENT_LIMIT','MANUAL_RETRY','LEASE_EXHAUSTED')),
 state VARCHAR(16) NOT NULL CHECK(state IN ('RETRY','LEASED','DONE','EXHAUSTED')),
 attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),version INTEGER NOT NULL CHECK(version>=0),
 attempt_event_id UUID UNIQUE REFERENCES payment_attempt_lab_events(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(job_id,key),UNIQUE(job_id,version)
);
CREATE FUNCTION yumi_query_lab_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'attempts'-'version'-'next_run_at'-'lease_token'-'lease_until') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'attempts'-'version'-'next_run_at'-'lease_token'-'lease_until') OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Query job identity immutable; event version required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER query_lab_update BEFORE UPDATE ON payment_query_lab_jobs FOR EACH ROW EXECUTE FUNCTION yumi_query_lab_update();
CREATE TRIGGER query_lab_no_delete BEFORE DELETE ON payment_query_lab_jobs FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER query_lab_event_immutable BEFORE UPDATE OR DELETE ON payment_query_lab_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_query_lab_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; j record; e record; n integer;
BEGIN
 IF TG_TABLE_NAME='payment_query_lab_jobs' THEN target:=NEW.id; ELSE target:=NEW.job_id; END IF;
 SELECT * INTO j FROM payment_query_lab_jobs WHERE id=target;
 SELECT COUNT(*) INTO n FROM payment_query_lab_events WHERE job_id=target;
 SELECT * INTO e FROM payment_query_lab_events WHERE job_id=target ORDER BY version DESC LIMIT 1;
 IF n<>j.version+1 OR e.version IS DISTINCT FROM j.version OR e.state IS DISTINCT FROM j.state OR e.attempts IS DISTINCT FROM j.attempts OR
 EXISTS(SELECT 1 FROM payment_query_lab_events q JOIN payment_attempt_lab_events a ON a.id=q.attempt_event_id WHERE q.job_id=target AND a.attempt_id<>j.attempt_id) THEN RAISE EXCEPTION 'Query job must match immutable event history'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER query_lab_consistency AFTER INSERT OR UPDATE ON payment_query_lab_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_query_lab_consistent();
CREATE CONSTRAINT TRIGGER query_lab_event_consistency AFTER INSERT ON payment_query_lab_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_query_lab_consistent();
-- Existing isolated unknown evidence also gets a durable task; real orders are untouched.
INSERT INTO payment_query_lab_jobs(id,attempt_id,warehouse_id) SELECT gen_random_uuid(),id,warehouse_id FROM payment_attempt_labs WHERE evidence='UNKNOWN';
INSERT INTO payment_query_lab_events(id,job_id,key,reason,state,attempts,version) SELECT gen_random_uuid(),id,id,'SCHEDULED','RETRY',0,0 FROM payment_query_lab_jobs;
COMMIT;
