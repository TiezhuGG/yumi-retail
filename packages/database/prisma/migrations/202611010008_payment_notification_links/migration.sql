BEGIN;
CREATE TABLE payment_notification_lab_bindings (
 attempt_id UUID PRIMARY KEY,warehouse_id UUID NOT NULL,app_id VARCHAR(32) NOT NULL CHECK(app_id='wx1111111111111111'),merchant_id VARCHAR(32) NOT NULL CHECK(merchant_id='1900000109'),
 out_trade_no VARCHAR(32) NOT NULL CHECK(out_trade_no LIKE 'SYNTHETIC_%'),amount_cents BIGINT NOT NULL CHECK(amount_cents=2499),currency VARCHAR(3) NOT NULL CHECK(currency='CNY'),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(attempt_id,warehouse_id) REFERENCES payment_attempt_labs(id,warehouse_id) ON DELETE RESTRICT, UNIQUE(attempt_id,warehouse_id),UNIQUE(warehouse_id,out_trade_no)
);
CREATE TABLE payment_notification_lab_applications (
 id UUID PRIMARY KEY,attempt_id UUID NOT NULL UNIQUE,warehouse_id UUID NOT NULL,transaction_id VARCHAR(64) NOT NULL CHECK(transaction_id LIKE 'SYNTHETIC_%'),success_time VARCHAR(40) NOT NULL,
 attempt_event_id UUID NOT NULL UNIQUE REFERENCES payment_attempt_lab_events(id) ON DELETE RESTRICT,created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(attempt_id,warehouse_id) REFERENCES payment_notification_lab_bindings(attempt_id,warehouse_id) ON DELETE RESTRICT,UNIQUE(attempt_id,warehouse_id),UNIQUE(warehouse_id,transaction_id)
);
ALTER TABLE notification_lab_records ADD application_id UUID REFERENCES payment_notification_lab_applications(id) ON DELETE RESTRICT;
CREATE INDEX notification_lab_application_idx ON notification_lab_records(application_id,created_at,id);
CREATE TRIGGER notification_binding_immutable BEFORE UPDATE OR DELETE ON payment_notification_lab_bindings FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER notification_application_immutable BEFORE UPDATE OR DELETE ON payment_notification_lab_applications FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_notification_link_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; e record; b record;
BEGIN
 IF TG_TABLE_NAME='payment_notification_lab_applications' THEN
 SELECT * INTO e FROM payment_attempt_lab_events WHERE id=NEW.attempt_event_id;
 IF e.attempt_id IS DISTINCT FROM NEW.attempt_id OR e.observation IS DISTINCT FROM 'SUCCEEDED' OR e.action IS DISTINCT FROM 'SUCCESS_RESULT' OR e.key IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Notification application must match success evidence'; END IF;
 ELSE
 IF NEW.application_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO a FROM payment_notification_lab_applications WHERE id=NEW.application_id;
 SELECT * INTO b FROM payment_notification_lab_bindings WHERE attempt_id=a.attempt_id;
 IF a.warehouse_id IS DISTINCT FROM NEW.warehouse_id OR a.transaction_id IS DISTINCT FROM NEW.transaction_id OR a.success_time IS DISTINCT FROM NEW.success_time OR b.out_trade_no IS DISTINCT FROM NEW.out_trade_no OR b.amount_cents IS DISTINCT FROM NEW.amount_cents OR b.currency IS DISTINCT FROM NEW.currency THEN RAISE EXCEPTION 'Notification record must match immutable binding and transaction'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_application_valid BEFORE INSERT ON payment_notification_lab_applications FOR EACH ROW EXECUTE FUNCTION yumi_notification_link_valid();
CREATE TRIGGER notification_record_link_valid BEFORE INSERT ON notification_lab_records FOR EACH ROW EXECUTE FUNCTION yumi_notification_link_valid();
CREATE FUNCTION yumi_notification_application_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM notification_lab_records WHERE application_id=NEW.id) THEN RAISE EXCEPTION 'Notification application requires a verified fact record'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notification_application_complete AFTER INSERT ON payment_notification_lab_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_notification_application_complete();
ALTER TABLE payment_query_lab_events DROP CONSTRAINT payment_query_lab_events_reason_check;
ALTER TABLE payment_query_lab_events ADD CHECK(reason IN ('SCHEDULED','CLAIMED','LEASE_RECOVERED','RETRY_UNKNOWN','EXHAUSTED_UNKNOWN','STOPPED_KNOWN','EVENT_LIMIT','MANUAL_RETRY','LEASE_EXHAUSTED','REVIEW_REQUIRED','CLASSIFIED_KNOWN','NOTIFICATION_EVIDENCE'));
COMMIT;
