-- Preparation never calls a provider: paid/pending channel states are deliberately impossible.
CREATE TABLE payment_preparations (
 id UUID PRIMARY KEY, order_id UUID NOT NULL UNIQUE REFERENCES consumer_orders(id) ON DELETE RESTRICT,
 user_id UUID NOT NULL, warehouse_id UUID NOT NULL, key UUID NOT NULL,
 amount_cents BIGINT NOT NULL CHECK(amount_cents>=0), currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 channel VARCHAR(16) NOT NULL DEFAULT 'DISABLED' CHECK(channel='DISABLED'),
 state VARCHAR(16) NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED','CLOSED')),
 prepared_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TIMESTAMPTZ(3), close_reason VARCHAR(24),
 CHECK((state='PREPARED' AND closed_at IS NULL AND close_reason IS NULL) OR
 (state='CLOSED' AND closed_at IS NOT NULL AND close_reason IS NOT NULL AND closed_at>=prepared_at AND close_reason IN ('CONSUMER_CANCEL','PAYMENT_TIMEOUT'))),
 UNIQUE(user_id,key)
);
CREATE TABLE payment_preparation_events (
 id UUID PRIMARY KEY, preparation_id UUID NOT NULL REFERENCES payment_preparations(id) ON DELETE RESTRICT,
 type VARCHAR(16) NOT NULL CHECK(type IN ('PREPARED','CLOSED')),
 actor_kind VARCHAR(16) NOT NULL CHECK(actor_kind IN ('CONSUMER','SYSTEM')),
 request_id UUID NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(preparation_id,type)
);
CREATE FUNCTION yumi_payment_preparation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'closed_at'-'close_reason') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'closed_at'-'close_reason') OR OLD.state<>'PREPARED' OR NEW.state<>'CLOSED' THEN RAISE EXCEPTION 'Payment preparation only permits first close'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_preparation_close_only BEFORE UPDATE ON payment_preparations FOR EACH ROW EXECUTE FUNCTION yumi_payment_preparation_immutable();
CREATE TRIGGER payment_preparation_no_delete BEFORE DELETE ON payment_preparations FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER payment_preparation_events_immutable BEFORE UPDATE OR DELETE ON payment_preparation_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_verify_payment_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; p record; o record;
BEGIN
 IF TG_TABLE_NAME='consumer_orders' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='payment_preparations' THEN target:=NEW.order_id;
 ELSE SELECT order_id INTO target FROM payment_preparations WHERE id=NEW.preparation_id; END IF;
 SELECT * INTO p FROM payment_preparations WHERE order_id=target;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO o FROM consumer_orders WHERE id=target;
 IF p.user_id<>o.user_id OR p.warehouse_id<>o.warehouse_id OR p.amount_cents<>o.payable_cents OR p.prepared_at<o.created_at OR p.prepared_at>=o.payment_deadline OR o.payment_state<>'NOT_STARTED' OR
 NOT EXISTS(SELECT 1 FROM payment_preparation_events WHERE preparation_id=p.id AND type='PREPARED' AND actor_kind='CONSUMER') OR
 (p.state='PREPARED' AND (o.status<>'AWAITING_PAYMENT' OR EXISTS(SELECT 1 FROM payment_preparation_events WHERE preparation_id=p.id AND type='CLOSED'))) OR
 (p.state='CLOSED' AND (o.status<>'CANCELED' OR p.close_reason IS DISTINCT FROM o.cancel_reason OR NOT EXISTS(SELECT 1 FROM payment_preparation_events WHERE preparation_id=p.id AND type='CLOSED' AND actor_kind=CASE WHEN p.close_reason='PAYMENT_TIMEOUT' THEN 'SYSTEM' ELSE 'CONSUMER' END)))
 THEN RAISE EXCEPTION 'Payment preparation must match order, amount and audit events'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_preparation_consistency AFTER INSERT OR UPDATE ON payment_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_verify_payment_preparation();
CREATE CONSTRAINT TRIGGER payment_preparation_event_consistency AFTER INSERT ON payment_preparation_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_verify_payment_preparation();
CREATE CONSTRAINT TRIGGER payment_preparation_order_consistency AFTER UPDATE ON consumer_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_verify_payment_preparation();
