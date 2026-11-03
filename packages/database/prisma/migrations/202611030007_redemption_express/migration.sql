CREATE TABLE consumer_express_address_books (
 user_id UUID PRIMARY KEY REFERENCES consumer_users(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE consumer_express_addresses (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES consumer_express_address_books(user_id) ON DELETE RESTRICT,
 payload TEXT,
 is_default BOOLEAN NOT NULL DEFAULT false,
 deleted BOOLEAN NOT NULL DEFAULT false,
 CHECK ((deleted AND payload IS NULL AND NOT is_default) OR (NOT deleted AND payload IS NOT NULL))
);
CREATE INDEX consumer_express_addresses_owner_idx ON consumer_express_addresses(user_id,deleted);
CREATE UNIQUE INDEX consumer_express_addresses_one_default_idx ON consumer_express_addresses(user_id) WHERE is_default AND NOT deleted;
CREATE TABLE consumer_express_address_operations (
 user_id UUID NOT NULL REFERENCES consumer_express_address_books(user_id) ON DELETE RESTRICT,
 key UUID NOT NULL, digest CHAR(64) NOT NULL, result JSONB NOT NULL,
 PRIMARY KEY(user_id,key)
);
CREATE TABLE consumer_express_address_audits (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES consumer_express_address_books(user_id) ON DELETE RESTRICT,
 address_id UUID NOT NULL, version INTEGER NOT NULL, action VARCHAR(16) NOT NULL,
 request_id UUID NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX consumer_express_address_audits_owner_idx ON consumer_express_address_audits(user_id,created_at);

CREATE TABLE redemption_express_policies(warehouse_id uuid PRIMARY KEY REFERENCES warehouses(id) ON DELETE RESTRICT,enabled boolean NOT NULL DEFAULT false,provinces text[] NOT NULL DEFAULT '{}',shipping_fee_mode varchar(20) NOT NULL CHECK(shipping_fee_mode='SENDER_PAID'),version integer NOT NULL DEFAULT 0 CHECK(version>=0));
ALTER TABLE redemption_orders ADD delivery_mode varchar(20) NOT NULL DEFAULT 'LOCAL_NO_CASH' CHECK(delivery_mode IN ('LOCAL_NO_CASH','EXPRESS'));
ALTER TABLE redemption_outbox DROP CONSTRAINT redemption_outbox_state_check;
ALTER TABLE redemption_outbox ADD CHECK(state IN ('PENDING','LEASED','RETRY','FAILED','COMPLETED','CANCELED','EXPRESS_WAIT'));
CREATE OR REPLACE FUNCTION protect_redemption_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Redemption outbox cannot be deleted'; END IF;
 IF NEW.order_id<>OLD.order_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Immutable outbox source or invalid version'; END IF;
 IF NOT ((OLD.state IN ('PENDING','RETRY') AND NEW.state='LEASED' AND OLD.attempts<3 AND NEW.attempts=OLD.attempts+1) OR
 (OLD.state='LEASED' AND NEW.state='LEASED' AND OLD.lease_until<=clock_timestamp() AND OLD.attempts<3 AND NEW.attempts=OLD.attempts+1 AND NEW.lease_token<>OLD.lease_token) OR
 (OLD.state='LEASED' AND NEW.state IN ('COMPLETED','RETRY','FAILED') AND NEW.attempts=OLD.attempts) OR
 (OLD.state IN ('PENDING','LEASED','RETRY','FAILED','COMPLETED','EXPRESS_WAIT') AND NEW.state='CANCELED' AND NEW.attempts=OLD.attempts) OR
 (OLD.state='FAILED' AND NEW.state='RETRY' AND NEW.attempts=0)) THEN RAISE EXCEPTION 'Invalid redemption outbox transition'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION verify_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; o record;
BEGIN
 IF TG_TABLE_NAME='redemption_orders' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='points_ledger' THEN target:=NEW.redemption_id;
 ELSE target:=NEW.order_id; END IF;
 IF target IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO o FROM redemption_orders WHERE id=target;
 IF NOT FOUND THEN RAISE EXCEPTION 'Redemption source missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM redemption_quotes q WHERE q.id=o.quote_id AND q.user_id=o.user_id AND q.reward_id=o.reward_id AND (q.snapshot->>'quantity')::integer=o.quantity AND (q.snapshot->>'totalPoints')::bigint=o.total_points AND (q.snapshot->>'pointsPrice')::bigint=o.points_price) OR
 NOT EXISTS(SELECT 1 FROM points_ledger WHERE redemption_id=target AND redemption_action='REDEEM' AND user_id=o.user_id AND consumer_actor_id=o.user_id AND delta=-o.total_points AND action_key='REDEMPTION:'||target::text) OR
 NOT EXISTS(SELECT 1 FROM redemption_events WHERE order_id=target AND type='REDEMPTION_CREATED' AND consumer_actor_id=o.user_id) OR
 NOT EXISTS(SELECT 1 FROM redemption_outbox WHERE order_id=target AND ((o.status='ACTIVE' AND state IN ('PENDING','LEASED','RETRY','FAILED','COMPLETED','EXPRESS_WAIT')) OR (o.status='CANCELED' AND state='CANCELED'))) OR
 (SELECT COALESCE(SUM(quantity),0) FROM redemption_allocations WHERE order_id=target)<>o.quantity OR
 (o.status='ACTIVE' AND EXISTS(SELECT 1 FROM points_ledger WHERE redemption_id=target AND redemption_action='CANCEL')) OR
 (o.status='CANCELED' AND (NOT EXISTS(SELECT 1 FROM points_ledger WHERE redemption_id=target AND redemption_action='CANCEL' AND user_id=o.user_id AND consumer_actor_id=o.user_id AND delta=o.total_points AND action_key='REDEMPTION_CANCEL:'||target::text) OR NOT EXISTS(SELECT 1 FROM redemption_events WHERE order_id=target AND type='REDEMPTION_CANCELED' AND consumer_actor_id=o.user_id))) OR
 EXISTS(SELECT 1 FROM redemption_allocations a JOIN stock_ledger e ON e.id=a.reserve_ledger_id LEFT JOIN stock_ledger r ON r.id=a.release_ledger_id WHERE a.order_id=target AND (
 e.action_key<>'REDEMPTION_RESERVE:'||a.id::text OR e.delta_on_hand<>0 OR e.delta_blocked<>0 OR e.delta_reserved<>a.quantity OR e.actor_kind<>'CONSUMER' OR e.consumer_actor_id IS DISTINCT FROM o.user_id OR
 NOT EXISTS(SELECT 1 FROM position_ledger p WHERE p.stock_ledger_id=e.id AND p.position_id=a.position_id AND p.delta_on_hand=0 AND p.delta_blocked=0 AND p.delta_reserved=a.quantity) OR
 (o.status='ACTIVE' AND a.release_ledger_id IS NOT NULL) OR
 (o.status='CANCELED' AND (a.release_ledger_id IS NULL OR r.action_key<>'REDEMPTION_RELEASE:'||a.id::text OR r.delta_on_hand<>0 OR r.delta_blocked<>0 OR r.delta_reserved<>-a.quantity OR r.actor_kind<>'CONSUMER' OR r.consumer_actor_id IS DISTINCT FROM o.user_id OR NOT EXISTS(SELECT 1 FROM position_ledger p WHERE p.stock_ledger_id=r.id AND p.position_id=a.position_id AND p.delta_on_hand=0 AND p.delta_blocked=0 AND p.delta_reserved=-a.quantity)))))
 THEN RAISE EXCEPTION 'Redemption points, inventory, event and outbox must balance'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION guard_redemption_delivery_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text;
BEGIN
 IF TG_TABLE_NAME='redemption_orders' THEN
  SELECT COALESCE(snapshot->>'deliveryMode','LOCAL_NO_CASH') INTO mode FROM redemption_quotes WHERE id=NEW.quote_id;
  IF mode IS DISTINCT FROM NEW.delivery_mode THEN RAISE EXCEPTION 'Original quote delivery mode required'; END IF;
 ELSE
  SELECT delivery_mode INTO mode FROM redemption_orders WHERE id=NEW.order_id;
  IF TG_TABLE_NAME='redemption_picking_tasks' AND mode<>'LOCAL_NO_CASH' THEN RAISE EXCEPTION 'Express orders cannot enter rider picking'; END IF;
  IF TG_TABLE_NAME='redemption_outbox' AND ((mode='EXPRESS' AND NEW.state NOT IN ('EXPRESS_WAIT','CANCELED')) OR (mode='LOCAL_NO_CASH' AND NEW.state='EXPRESS_WAIT')) THEN RAISE EXCEPTION 'Delivery mode and work queue disagree'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_order_mode BEFORE INSERT ON redemption_orders FOR EACH ROW EXECUTE FUNCTION guard_redemption_delivery_mode();
CREATE TRIGGER redemption_job_mode BEFORE INSERT OR UPDATE ON redemption_outbox FOR EACH ROW EXECUTE FUNCTION guard_redemption_delivery_mode();
CREATE TRIGGER redemption_picking_mode BEFORE INSERT ON redemption_picking_tasks FOR EACH ROW EXECUTE FUNCTION guard_redemption_delivery_mode();
CREATE TRIGGER consumer_express_address_audit_immutable BEFORE UPDATE OR DELETE ON consumer_express_address_audits FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
