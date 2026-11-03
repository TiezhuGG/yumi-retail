CREATE TABLE redemption_express_shipments (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE, warehouse_id uuid NOT NULL, sku_id uuid NOT NULL,
 carrier_code varchar(20) NOT NULL CHECK(carrier_code IN ('SF','ZTO','YTO','STO','YUNDA','JD','EMS','POST','DEPPON','OTHER')),
 carrier_name varchar(40) NOT NULL CHECK(length(trim(carrier_name))>0),
 tracking_no varchar(40) NOT NULL CHECK(tracking_no ~ '^[A-Z0-9][A-Z0-9-]{5,39}$'),
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, actor_name varchar(80) NOT NULL,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(order_id,warehouse_id,sku_id) REFERENCES redemption_orders(id,warehouse_id,sku_id) ON DELETE RESTRICT,
 UNIQUE(order_id,warehouse_id,sku_id), CONSTRAINT redemption_express_tracking_key UNIQUE(warehouse_id,carrier_code,carrier_name,tracking_no)
);
CREATE TRIGGER redemption_express_shipment_immutable BEFORE UPDATE OR DELETE ON redemption_express_shipments FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_redemption_express_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record;
BEGIN
 SELECT * INTO o FROM redemption_orders WHERE id=NEW.order_id FOR UPDATE;
 IF o.id IS NULL OR o.status<>'ACTIVE' OR o.delivery_mode<>'EXPRESS' OR NOT EXISTS(SELECT 1 FROM redemption_outbox WHERE order_id=o.id AND state='EXPRESS_WAIT') OR EXISTS(SELECT 1 FROM redemption_picking_tasks WHERE order_id=o.id) THEN RAISE EXCEPTION 'Current active express order waiting shipment required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND s.display_name=NEW.actor_name AND r.role_code IN ('SUPER_ADMIN','OPERATIONS') AND w.warehouse_id=o.warehouse_id) THEN RAISE EXCEPTION 'Current scoped express shipping staff required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_express_ship_actor BEFORE INSERT ON redemption_express_shipments FOR EACH ROW EXECUTE FUNCTION protect_redemption_express_shipment();
ALTER TABLE redemption_outbox DROP CONSTRAINT redemption_outbox_state_check;
ALTER TABLE redemption_outbox ADD CHECK(state IN ('PENDING','LEASED','RETRY','FAILED','COMPLETED','CANCELED','EXPRESS_WAIT','EXPRESS_SHIPPED'));
ALTER TABLE redemption_outbox_events DROP CONSTRAINT redemption_outbox_events_reason_check;
ALTER TABLE redemption_outbox_events ADD CHECK(reason IN ('LEASED','RECOVERED','CREATED','RETRY','FAILED','CANCELED','MANUAL_RETRY','EXPRESS_SHIPPED'));
CREATE OR REPLACE FUNCTION protect_redemption_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Redemption outbox cannot be deleted'; END IF;
 IF NEW.order_id<>OLD.order_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Immutable outbox source or invalid version'; END IF;
 IF NOT ((OLD.state='EXPRESS_WAIT' AND NEW.state='EXPRESS_SHIPPED' AND NEW.attempts=OLD.attempts) OR (OLD.state IN ('PENDING','RETRY') AND NEW.state='LEASED' AND OLD.attempts<3 AND NEW.attempts=OLD.attempts+1) OR
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
 NOT EXISTS(SELECT 1 FROM redemption_outbox WHERE order_id=target AND ((o.status='ACTIVE' AND state IN ('PENDING','LEASED','RETRY','FAILED','COMPLETED','EXPRESS_WAIT','EXPRESS_SHIPPED')) OR (o.status='CANCELED' AND state='CANCELED'))) OR
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

CREATE OR REPLACE FUNCTION guard_redemption_delivery_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text;
BEGIN
 IF TG_TABLE_NAME='redemption_orders' THEN
  SELECT COALESCE(snapshot->>'deliveryMode','LOCAL_NO_CASH') INTO mode FROM redemption_quotes WHERE id=NEW.quote_id;
  IF mode IS DISTINCT FROM NEW.delivery_mode THEN RAISE EXCEPTION 'Original quote delivery mode required'; END IF;
 ELSE
  SELECT delivery_mode INTO mode FROM redemption_orders WHERE id=NEW.order_id;
  IF TG_TABLE_NAME='redemption_picking_tasks' AND mode<>'LOCAL_NO_CASH' THEN RAISE EXCEPTION 'Express orders cannot enter rider picking'; END IF;
  IF TG_TABLE_NAME='redemption_outbox' AND ((mode='EXPRESS' AND NEW.state NOT IN ('EXPRESS_WAIT','EXPRESS_SHIPPED','CANCELED')) OR (mode='LOCAL_NO_CASH' AND NEW.state IN ('EXPRESS_WAIT','EXPRESS_SHIPPED'))) THEN RAISE EXCEPTION 'Delivery mode and work queue disagree'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION assert_redemption_express_shipping(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE sh record; o record; j record;
BEGIN
 SELECT * INTO sh FROM redemption_express_shipments WHERE order_id=target;
 SELECT * INTO o FROM redemption_orders WHERE id=target;
 SELECT * INTO j FROM redemption_outbox WHERE order_id=target;
 IF sh.id IS NULL THEN
  IF j.state='EXPRESS_SHIPPED' OR EXISTS(SELECT 1 FROM redemption_allocations WHERE order_id=target AND consume_ledger_id IS NOT NULL) THEN RAISE EXCEPTION 'Express consumption requires immutable shipment'; END IF;
  RETURN;
 END IF;
 IF o.delivery_mode<>'EXPRESS' OR o.status<>'ACTIVE' OR j.state IS DISTINCT FROM 'EXPRESS_SHIPPED' OR EXISTS(SELECT 1 FROM redemption_picking_tasks WHERE order_id=target) OR
 NOT EXISTS(SELECT 1 FROM redemption_allocations WHERE order_id=target) OR
 EXISTS(SELECT 1 FROM redemption_allocations a LEFT JOIN stock_ledger l ON l.id=a.consume_ledger_id WHERE a.order_id=target AND (
 a.consume_ledger_id IS NULL OR a.release_ledger_id IS NOT NULL OR l.action_key<>'REDEMPTION_SHIP:'||a.id::text OR l.actor_kind<>'STAFF' OR l.actor_id IS DISTINCT FROM sh.actor_id OR l.request_id<>sh.request_id OR
 l.delta_on_hand<>-a.quantity OR l.delta_reserved<>-a.quantity OR l.delta_blocked<>0 OR
 (SELECT COUNT(*) FROM position_ledger WHERE stock_ledger_id=l.id)<>1 OR NOT EXISTS(SELECT 1 FROM position_ledger p WHERE p.stock_ledger_id=l.id AND p.position_id=a.position_id AND p.delta_on_hand=-a.quantity AND p.delta_reserved=-a.quantity AND p.delta_blocked=0))) THEN RAISE EXCEPTION 'Express shipment must consume each original reservation with matching position facts'; END IF;
END $$;
CREATE FUNCTION verify_redemption_express_shipping() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='redemption_orders' THEN target:=NEW.id; ELSE target:=NEW.order_id; END IF;
 IF EXISTS(SELECT 1 FROM redemption_orders WHERE id=target AND delivery_mode='EXPRESS') THEN PERFORM assert_redemption_express_shipping(target); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER redemption_express_shipment_consistency AFTER INSERT ON redemption_express_shipments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_express_shipping();
CREATE CONSTRAINT TRIGGER redemption_express_job_consistency AFTER INSERT OR UPDATE ON redemption_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_express_shipping();
CREATE CONSTRAINT TRIGGER redemption_express_order_consistency AFTER INSERT OR UPDATE ON redemption_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_express_shipping();
CREATE OR REPLACE FUNCTION verify_redemption_packing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; t record; pk record; sh record;
BEGIN
 IF TG_TABLE_NAME='redemption_picking_tasks' THEN target:=NEW.order_id;
 ELSIF TG_TABLE_NAME='stock_ledger' THEN
  IF NEW.action_key NOT LIKE 'REDEMPTION_SHIP:%' THEN RETURN NULL; END IF;
  SELECT order_id INTO target FROM redemption_allocations WHERE consume_ledger_id=NEW.id;
  IF target IS NULL THEN RAISE EXCEPTION 'Shipment ledger must settle original allocation'; END IF;
 ELSE target:=NEW.order_id; END IF;
 IF EXISTS(SELECT 1 FROM redemption_orders WHERE id=target AND delivery_mode='EXPRESS') THEN PERFORM assert_redemption_express_shipping(target); RETURN NULL; END IF;
 SELECT * INTO t FROM redemption_picking_tasks WHERE order_id=target;
 SELECT * INTO pk FROM redemption_packs WHERE order_id=target;
 SELECT * INTO sh FROM redemption_shipments WHERE order_id=target;
 IF pk.id IS NOT NULL THEN
  IF t.state<>'CHECKED' OR t.version<>pk.task_version OR pk.actor_id<>t.owner_id OR
   NOT EXISTS(SELECT 1 FROM redemption_picking_work WHERE task_id=t.id AND version=t.version AND action='COMPLETE') OR
   EXISTS(SELECT 1 FROM redemption_allocations a WHERE a.order_id=target AND (
    NOT EXISTS(SELECT 1 FROM redemption_pack_lines pl WHERE pl.pack_id=pk.id AND pl.allocation_id=a.id AND pl.quantity=a.quantity) OR
    NOT EXISTS(SELECT 1 FROM redemption_picking_work c WHERE c.task_id=t.id AND c.allocation_id=a.id AND c.action='CHECK' AND c.version=(SELECT MAX(e.version) FROM redemption_picking_work e WHERE e.task_id=t.id AND e.allocation_id=a.id)))) THEN RAISE EXCEPTION 'Packing requires every original checked allocation and exact quantity'; END IF;
 END IF;
 IF sh.id IS NOT NULL THEN
  IF pk.id IS NULL OR sh.pack_id<>pk.id OR sh.task_version<>t.version OR NOT EXISTS(SELECT 1 FROM redemption_orders WHERE id=target AND status='ACTIVE') OR
  EXISTS(SELECT 1 FROM redemption_allocations a LEFT JOIN stock_ledger l ON l.id=a.consume_ledger_id WHERE a.order_id=target AND (
   a.consume_ledger_id IS NULL OR a.release_ledger_id IS NOT NULL OR l.action_key<>'REDEMPTION_SHIP:'||a.id::text OR l.actor_kind<>'STAFF' OR l.actor_id IS DISTINCT FROM sh.actor_id OR l.request_id<>sh.request_id OR
   l.delta_on_hand<>-a.quantity OR l.delta_reserved<>-a.quantity OR l.delta_blocked<>0 OR
   (SELECT COUNT(*) FROM position_ledger WHERE stock_ledger_id=l.id)<>1 OR
   NOT EXISTS(SELECT 1 FROM position_ledger e WHERE e.stock_ledger_id=l.id AND e.position_id=a.position_id AND e.delta_on_hand=-a.quantity AND e.delta_reserved=-a.quantity AND e.delta_blocked=0))) THEN RAISE EXCEPTION 'Shipment must consume all original reservations with matching stock and position facts'; END IF;
 ELSIF EXISTS(SELECT 1 FROM redemption_allocations WHERE order_id=target AND consume_ledger_id IS NOT NULL) THEN RAISE EXCEPTION 'Consumption requires immutable shipment'; END IF;
 RETURN NULL;
END $$;
