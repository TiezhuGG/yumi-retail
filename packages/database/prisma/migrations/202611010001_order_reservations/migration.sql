ALTER TABLE stock_ledger ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE stock_ledger ADD COLUMN actor_kind VARCHAR(16) NOT NULL DEFAULT 'STAFF';
ALTER TABLE stock_ledger ADD COLUMN consumer_actor_id UUID REFERENCES consumer_users(id) ON DELETE RESTRICT;
ALTER TABLE stock_ledger ADD CHECK ((actor_kind='STAFF' AND actor_id IS NOT NULL AND consumer_actor_id IS NULL) OR (actor_kind='CONSUMER' AND actor_id IS NULL AND consumer_actor_id IS NOT NULL) OR (actor_kind='SYSTEM' AND actor_id IS NULL AND consumer_actor_id IS NULL));
CREATE TABLE consumer_orders (
 id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
 quote_id UUID NOT NULL UNIQUE REFERENCES checkout_quotes(id) ON DELETE RESTRICT,
 key UUID NOT NULL,digest CHAR(64) NOT NULL,order_no VARCHAR(40) NOT NULL UNIQUE,
 status VARCHAR(24) NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK(status IN ('AWAITING_PAYMENT','CANCELED')),
 payment_state VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED' CHECK(payment_state='NOT_STARTED'),
 fulfillment_state VARCHAR(24) NOT NULL DEFAULT 'NOT_READY' CHECK(fulfillment_state='NOT_READY'),
 goods_cents BIGINT NOT NULL CHECK(goods_cents>=0),delivery_fee_cents BIGINT NOT NULL CHECK(delivery_fee_cents>=0),
 payable_cents BIGINT NOT NULL CHECK(payable_cents=goods_cents+delivery_fee_cents),address_payload TEXT NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL,payment_deadline TIMESTAMPTZ(3) NOT NULL CHECK(payment_deadline>created_at),
 cancel_reason VARCHAR(24),version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 CHECK((status='AWAITING_PAYMENT' AND cancel_reason IS NULL) OR (status='CANCELED' AND cancel_reason IN ('CONSUMER_CANCEL','PAYMENT_TIMEOUT'))),
 UNIQUE(user_id,key)
);
CREATE INDEX consumer_orders_owner_idx ON consumer_orders(user_id,created_at,id);
CREATE INDEX consumer_orders_deadline_idx ON consumer_orders(payment_deadline,id) WHERE status='AWAITING_PAYMENT';
CREATE TABLE order_items (
 id UUID PRIMARY KEY,order_id UUID NOT NULL REFERENCES consumer_orders(id) ON DELETE RESTRICT,
 sku_id UUID NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,name VARCHAR(120) NOT NULL,spec VARCHAR(100) NOT NULL,unit VARCHAR(16) NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 200),price_cents BIGINT NOT NULL CHECK(price_cents>0),line_cents BIGINT NOT NULL CHECK(line_cents=price_cents*quantity),UNIQUE(order_id,sku_id)
);
CREATE TABLE order_allocations (
 id UUID PRIMARY KEY,order_id UUID NOT NULL REFERENCES consumer_orders(id) ON DELETE RESTRICT,
 warehouse_id UUID NOT NULL,sku_id UUID NOT NULL,lot_id UUID NOT NULL,position_id UUID NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity>0),reserve_ledger_id UUID NOT NULL UNIQUE,release_ledger_id UUID UNIQUE,
 FOREIGN KEY(position_id,warehouse_id,sku_id,lot_id) REFERENCES stock_positions(id,warehouse_id,sku_id,lot_id) ON DELETE RESTRICT,
 FOREIGN KEY(reserve_ledger_id,warehouse_id,sku_id,lot_id) REFERENCES stock_ledger(id,warehouse_id,sku_id,lot_id) ON DELETE RESTRICT,
 FOREIGN KEY(release_ledger_id,warehouse_id,sku_id,lot_id) REFERENCES stock_ledger(id,warehouse_id,sku_id,lot_id) ON DELETE RESTRICT,
 UNIQUE(order_id,position_id)
);
CREATE TABLE order_events (
 id UUID PRIMARY KEY,order_id UUID NOT NULL REFERENCES consumer_orders(id) ON DELETE RESTRICT,
 type VARCHAR(32) NOT NULL CHECK(type IN ('ORDER_CREATED','ORDER_CANCELED')),
 actor_kind VARCHAR(16) NOT NULL CHECK(actor_kind IN ('CONSUMER','SYSTEM')),request_id UUID NOT NULL,
 payload JSONB NOT NULL,state VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(state='PENDING'),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(order_id,type)
);
CREATE TRIGGER order_items_append_only BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_order_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'status'-'cancel_reason'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'cancel_reason'-'version') OR OLD.status<>'AWAITING_PAYMENT' OR NEW.status<>'CANCELED' OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Order snapshots are immutable; only unpaid cancellation is allowed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER consumer_order_immutable BEFORE UPDATE ON consumer_orders FOR EACH ROW EXECUTE FUNCTION yumi_order_immutable();
CREATE FUNCTION yumi_verify_order_reservations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; o record;
BEGIN
 IF TG_TABLE_NAME='consumer_orders' THEN target:=NEW.id; ELSE target:=NEW.order_id; END IF;
 SELECT * INTO o FROM consumer_orders WHERE id=target;
 IF NOT EXISTS(SELECT 1 FROM checkout_quotes q WHERE q.id=o.quote_id AND q.user_id=o.user_id) OR
 NOT EXISTS(SELECT 1 FROM order_items WHERE order_id=target) OR
 o.goods_cents<>(SELECT COALESCE(SUM(line_cents),0) FROM order_items WHERE order_id=target) OR
 EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=target AND i.quantity<>(SELECT COALESCE(SUM(a.quantity),0) FROM order_allocations a WHERE a.order_id=target AND a.sku_id=i.sku_id)) OR
 EXISTS(SELECT 1 FROM order_allocations a LEFT JOIN stock_ledger e ON e.id=a.reserve_ledger_id LEFT JOIN stock_ledger r ON r.id=a.release_ledger_id WHERE a.order_id=target AND (
 a.warehouse_id<>o.warehouse_id OR NOT EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=target AND i.sku_id=a.sku_id) OR
 e.delta_on_hand<>0 OR e.delta_blocked<>0 OR e.delta_reserved<>a.quantity OR e.actor_kind<>'CONSUMER' OR e.consumer_actor_id<>o.user_id OR
 NOT EXISTS(SELECT 1 FROM position_ledger p WHERE p.stock_ledger_id=e.id AND p.position_id=a.position_id AND p.delta_on_hand=0 AND p.delta_blocked=0 AND p.delta_reserved=a.quantity) OR
 (o.status='AWAITING_PAYMENT' AND a.release_ledger_id IS NOT NULL) OR
 (o.status='CANCELED' AND (a.release_ledger_id IS NULL OR r.delta_on_hand<>0 OR r.delta_blocked<>0 OR r.delta_reserved<>-a.quantity OR NOT EXISTS(SELECT 1 FROM position_ledger p WHERE p.stock_ledger_id=r.id AND p.position_id=a.position_id AND p.delta_on_hand=0 AND p.delta_blocked=0 AND p.delta_reserved=-a.quantity))))) THEN
 RAISE EXCEPTION 'Order items, reservation allocations and ledger must balance';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_reservation_consistency AFTER INSERT OR UPDATE ON consumer_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_verify_order_reservations();
CREATE CONSTRAINT TRIGGER order_item_reservation_consistency AFTER INSERT ON order_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_verify_order_reservations();
CREATE CONSTRAINT TRIGGER order_allocation_consistency AFTER INSERT OR UPDATE ON order_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_verify_order_reservations();
CREATE FUNCTION yumi_order_allocation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'release_ledger_id') IS DISTINCT FROM (to_jsonb(OLD)-'release_ledger_id') OR OLD.release_ledger_id IS NOT NULL OR NEW.release_ledger_id IS NULL THEN RAISE EXCEPTION 'Only a first reservation release may change an allocation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER allocation_release_only BEFORE UPDATE ON order_allocations FOR EACH ROW EXECUTE FUNCTION yumi_order_allocation_immutable();
CREATE TRIGGER allocation_no_delete BEFORE DELETE ON order_allocations FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
