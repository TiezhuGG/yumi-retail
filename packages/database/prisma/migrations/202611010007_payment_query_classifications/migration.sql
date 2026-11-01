BEGIN;
ALTER TABLE payment_query_lab_jobs DROP CONSTRAINT payment_query_lab_jobs_state_check;
ALTER TABLE payment_query_lab_jobs ADD CHECK(state IN ('RETRY','LEASED','DONE','EXHAUSTED','REVIEW'));
ALTER TABLE payment_query_lab_events DROP CONSTRAINT payment_query_lab_events_state_check;
ALTER TABLE payment_query_lab_events ADD CHECK(state IN ('RETRY','LEASED','DONE','EXHAUSTED','REVIEW'));
ALTER TABLE payment_query_lab_events DROP CONSTRAINT payment_query_lab_events_reason_check;
ALTER TABLE payment_query_lab_events ADD CHECK(reason IN ('SCHEDULED','CLAIMED','LEASE_RECOVERED','RETRY_UNKNOWN','EXHAUSTED_UNKNOWN','STOPPED_KNOWN','EVENT_LIMIT','MANUAL_RETRY','LEASE_EXHAUSTED','REVIEW_REQUIRED','CLASSIFIED_KNOWN'));
ALTER TABLE payment_review_lab_notes DROP CONSTRAINT payment_review_lab_notes_task_state_check;
ALTER TABLE payment_review_lab_notes ADD CHECK(task_state IN ('RETRY','LEASED','DONE','EXHAUSTED','REVIEW'));
ALTER TABLE payment_query_lab_events ADD classification VARCHAR(32), ADD result_evidence VARCHAR(16), ADD next VARCHAR(16), ADD scenario VARCHAR(32);
-- Historical events remain null, never invent a past channel observation.
ALTER TABLE payment_query_lab_events ADD CONSTRAINT query_classification_shape CHECK (
 (classification IS NULL AND result_evidence IS NULL AND next IS NULL AND scenario IS NULL)
 OR (classification IS NOT NULL AND result_evidence IS NOT NULL AND next IS NOT NULL AND scenario IS NOT NULL AND attempt_event_id IS NOT NULL AND
 scenario IN ('SUCCESS','CLOSED','NOTPAY','USERPAYING','TIMEOUT','NETWORK','RATE','RULE','SERVER','MISSING','REJECTED','UNVERIFIED','BINDING','AMOUNT','MALFORMED','NO_TRANSACTION','UNSUPPORTED') AND
 ((classification IN ('TIMEOUT','TRANSPORT','RATE_LIMIT','SERVER_ERROR','PENDING') AND result_evidence='UNKNOWN' AND next='RETRY' AND state IN ('RETRY','EXHAUSTED')) OR
 (classification IN ('NOT_FOUND','REJECTED','INVALID_RESPONSE','UNVERIFIED','BINDING_MISMATCH','UNSUPPORTED_STATE') AND result_evidence='UNKNOWN' AND next='REVIEW' AND state='REVIEW') OR
 (classification='SUCCEEDED' AND result_evidence='SUCCEEDED' AND next='RECONCILE' AND state IN ('DONE','REVIEW')) OR
 (classification='CLOSED' AND result_evidence='CLOSED' AND next='RECONCILE' AND state IN ('DONE','REVIEW'))))
);
CREATE FUNCTION yumi_query_classification_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observation varchar; merged varchar;
BEGIN
 IF NEW.classification IS NOT NULL THEN
 SELECT a.observation,a.evidence INTO observation,merged FROM payment_attempt_lab_events a WHERE a.id=NEW.attempt_event_id;
 IF observation IS DISTINCT FROM NEW.result_evidence THEN RAISE EXCEPTION 'Classified query evidence must match linked attempt observation'; END IF;
 IF NEW.next='RECONCILE' AND ((NEW.state='REVIEW') IS DISTINCT FROM (merged='CONFLICT')) THEN RAISE EXCEPTION 'Conflicting known query evidence requires review'; END IF;
 IF NEW.reason IS DISTINCT FROM (CASE WHEN NEW.state='REVIEW' THEN 'REVIEW_REQUIRED' WHEN NEW.next='RECONCILE' THEN 'CLASSIFIED_KNOWN' WHEN NEW.state='EXHAUSTED' THEN 'EXHAUSTED_UNKNOWN' ELSE 'RETRY_UNKNOWN' END) THEN RAISE EXCEPTION 'Classified query reason must match outcome'; END IF;
 END IF;
 IF NEW.reason IN ('REVIEW_REQUIRED','CLASSIFIED_KNOWN','RETRY_UNKNOWN','EXHAUSTED_UNKNOWN') AND NEW.classification IS NULL THEN RAISE EXCEPTION 'Classified outcome required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER query_classification_valid BEFORE INSERT ON payment_query_lab_events FOR EACH ROW EXECUTE FUNCTION yumi_query_classification_valid();
COMMIT;
