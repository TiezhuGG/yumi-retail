-- Synthetic attempt evidence only; deliberately no order/payment foreign keys.
CREATE TABLE payment_attempt_labs (
 id UUID PRIMARY KEY, warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
 key UUID NOT NULL, evidence VARCHAR(16) NOT NULL DEFAULT 'NONE' CHECK(evidence IN ('NONE','UNKNOWN','CLOSED','SUCCEEDED','CONFLICT')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 100),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(warehouse_id,key)
);
CREATE INDEX payment_attempt_labs_warehouse_created_idx ON payment_attempt_labs(warehouse_id,created_at,id);
CREATE TABLE payment_attempt_lab_events (
 id UUID PRIMARY KEY, attempt_id UUID NOT NULL REFERENCES payment_attempt_labs(id) ON DELETE RESTRICT,
 key UUID NOT NULL, action VARCHAR(24) NOT NULL CHECK(action IN ('STARTED','UNKNOWN_RESULT','CLOSED_RESULT','SUCCESS_RESULT')),
 observation VARCHAR(16) NOT NULL, evidence VARCHAR(16) NOT NULL CHECK(evidence IN ('NONE','UNKNOWN','CLOSED','SUCCEEDED','CONFLICT')),
 version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 100), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((action='STARTED' AND observation='NONE' AND version=0) OR (action='UNKNOWN_RESULT' AND observation='UNKNOWN' AND version>0) OR (action='CLOSED_RESULT' AND observation='CLOSED' AND version>0) OR (action='SUCCESS_RESULT' AND observation='SUCCEEDED' AND version>0)),
 UNIQUE(attempt_id,key), UNIQUE(attempt_id,version)
);
CREATE FUNCTION yumi_lab_evidence_merge(a text,b text) RETURNS text LANGUAGE SQL IMMUTABLE AS $$
 SELECT CASE WHEN a='CONFLICT' OR b='CONFLICT' OR (a='CLOSED' AND b='SUCCEEDED') OR (a='SUCCEEDED' AND b='CLOSED') THEN 'CONFLICT'
 WHEN a='SUCCEEDED' OR b='SUCCEEDED' THEN 'SUCCEEDED' WHEN a='CLOSED' OR b='CLOSED' THEN 'CLOSED'
 WHEN a='UNKNOWN' OR b='UNKNOWN' THEN 'UNKNOWN' ELSE 'NONE' END
$$;
CREATE FUNCTION yumi_attempt_lab_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'evidence'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'evidence'-'version') OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Attempt evidence must advance with an event'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attempt_lab_update BEFORE UPDATE ON payment_attempt_labs FOR EACH ROW EXECUTE FUNCTION yumi_attempt_lab_update();
CREATE TRIGGER attempt_lab_no_delete BEFORE DELETE ON payment_attempt_labs FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER attempt_lab_events_immutable BEFORE UPDATE OR DELETE ON payment_attempt_lab_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_attempt_lab_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; a record; e record; n integer;
BEGIN
 IF TG_TABLE_NAME='payment_attempt_labs' THEN target:=NEW.id; ELSE target:=NEW.attempt_id; END IF;
 SELECT * INTO a FROM payment_attempt_labs WHERE id=target;
 SELECT COUNT(*) INTO n FROM payment_attempt_lab_events WHERE attempt_id=target;
 IF n<>a.version+1 OR NOT EXISTS(SELECT 1 FROM payment_attempt_lab_events WHERE attempt_id=target AND version=0 AND action='STARTED' AND key=a.key AND evidence='NONE') THEN RAISE EXCEPTION 'Attempt start/event chain missing'; END IF;
 SELECT * INTO e FROM payment_attempt_lab_events WHERE attempt_id=target ORDER BY version DESC LIMIT 1;
 IF e.version<>a.version OR e.evidence<>a.evidence OR EXISTS(
 SELECT 1 FROM (SELECT version,evidence,observation,LAG(evidence,1,'NONE') OVER(ORDER BY version) AS previous FROM payment_attempt_lab_events WHERE attempt_id=target) chain
 WHERE evidence<>yumi_lab_evidence_merge(previous,observation)
 ) THEN RAISE EXCEPTION 'Attempt evidence disagrees with immutable event chain'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER attempt_lab_consistency AFTER INSERT OR UPDATE ON payment_attempt_labs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_attempt_lab_consistent();
CREATE CONSTRAINT TRIGGER attempt_lab_event_consistency AFTER INSERT ON payment_attempt_lab_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_attempt_lab_consistent();
