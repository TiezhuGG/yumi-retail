-- P4a: real redemption source, task materialization and competitive claim only.
ALTER TABLE redemption_outbox DROP CONSTRAINT redemption_outbox_state_check;
ALTER TABLE redemption_outbox ADD CHECK(state IN ('PENDING','LEASED','RETRY','FAILED','COMPLETED','CANCELED'));
ALTER TABLE redemption_outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3);
ALTER TABLE redemption_outbox ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK(version>=0);
ALTER TABLE redemption_outbox ADD COLUMN lease_token uuid;
ALTER TABLE redemption_outbox ADD COLUMN lease_until timestamptz(3);
ALTER TABLE redemption_outbox ADD COLUMN next_attempt_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE redemption_outbox ADD COLUMN last_error_code varchar(40) CHECK(last_error_code IN ('WAREHOUSE_PAUSED','SOURCE_UNAVAILABLE','RESERVATION_UNAVAILABLE','PROCESSING_FAILED','LEASE_EXHAUSTED'));
ALTER TABLE redemption_outbox ADD CHECK((state='LEASED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND attempts>0) OR (state<>'LEASED' AND lease_token IS NULL AND lease_until IS NULL));
CREATE INDEX redemption_outbox_due_idx ON redemption_outbox(state,next_attempt_at,order_id);
CREATE TABLE redemption_outbox_events (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES redemption_outbox(order_id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0), state varchar(16) NOT NULL, attempts integer NOT NULL,
 reason varchar(24) NOT NULL CHECK(reason IN ('LEASED','RECOVERED','CREATED','RETRY','FAILED','CANCELED','MANUAL_RETRY')),
 last_error_code varchar(40), lease_token uuid, actor_id uuid REFERENCES staff(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_id,version)
);
CREATE TABLE redemption_picking_tasks (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE, warehouse_id uuid NOT NULL, sku_id uuid NOT NULL,
 state varchar(16) NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','CLAIMED','CANCELED')),
 owner_id uuid REFERENCES staff(id) ON DELETE RESTRICT, claimed_at timestamptz(3),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0), created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(order_id,warehouse_id,sku_id) REFERENCES redemption_orders(id,warehouse_id,sku_id) ON DELETE RESTRICT,
 CHECK((state='CLAIMED' AND owner_id IS NOT NULL AND claimed_at IS NOT NULL) OR (state IN ('READY','CANCELED') AND owner_id IS NULL AND claimed_at IS NULL)),
 UNIQUE(id,order_id), UNIQUE(order_id,warehouse_id,sku_id)
);
CREATE INDEX redemption_picking_scope_idx ON redemption_picking_tasks(warehouse_id,state,id);
CREATE TABLE redemption_picking_events (
 id uuid PRIMARY KEY, task_id uuid NOT NULL, order_id uuid NOT NULL,
 action varchar(16) NOT NULL CHECK(action IN ('CREATED','CLAIMED','CANCELED')),
 actor_id uuid REFERENCES staff(id) ON DELETE RESTRICT,
 consumer_actor_id uuid REFERENCES consumer_users(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(task_id,order_id) REFERENCES redemption_picking_tasks(id,order_id) ON DELETE RESTRICT,
 CHECK((action='CREATED' AND actor_id IS NULL AND consumer_actor_id IS NULL) OR (action='CLAIMED' AND actor_id IS NOT NULL AND consumer_actor_id IS NULL) OR (action='CANCELED' AND actor_id IS NULL AND consumer_actor_id IS NOT NULL)),
 UNIQUE(task_id,action)
);
CREATE TRIGGER redemption_outbox_events_immutable BEFORE UPDATE OR DELETE ON redemption_outbox_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_picking_events_immutable BEFORE UPDATE OR DELETE ON redemption_picking_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE OR REPLACE FUNCTION protect_redemption_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Redemption outbox cannot be deleted'; END IF;
 IF NEW.order_id<>OLD.order_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Immutable outbox source or invalid version'; END IF;
 IF NOT ((OLD.state IN ('PENDING','RETRY') AND NEW.state='LEASED' AND OLD.attempts<3 AND NEW.attempts=OLD.attempts+1) OR
 (OLD.state='LEASED' AND NEW.state='LEASED' AND OLD.lease_until<=clock_timestamp() AND OLD.attempts<3 AND NEW.attempts=OLD.attempts+1 AND NEW.lease_token<>OLD.lease_token) OR
 (OLD.state='LEASED' AND NEW.state IN ('COMPLETED','RETRY','FAILED') AND NEW.attempts=OLD.attempts) OR
 (OLD.state IN ('PENDING','LEASED','RETRY','FAILED','COMPLETED') AND NEW.state='CANCELED' AND NEW.attempts=OLD.attempts) OR
 (OLD.state='FAILED' AND NEW.state='RETRY' AND NEW.attempts=0)) THEN RAISE EXCEPTION 'Invalid redemption outbox transition'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION protect_redemption_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Picking task cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN IF NEW.state<>'READY' OR NEW.version<>0 OR NEW.owner_id IS NOT NULL OR NEW.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'Picking task starts ready'; END IF; RETURN NEW; END IF;
 IF (to_jsonb(NEW)-'state'-'owner_id'-'claimed_at'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'owner_id'-'claimed_at'-'version') OR OLD.state<>'READY' OR NEW.state NOT IN ('CLAIMED','CANCELED') OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid picking task transition'; END IF;
 IF NEW.state='CLAIMED' AND NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.owner_id AND s.enabled AND w.warehouse_id=NEW.warehouse_id AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER','PICKER')) THEN RAISE EXCEPTION 'Picking owner unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_picking_protection BEFORE INSERT OR UPDATE OR DELETE ON redemption_picking_tasks FOR EACH ROW EXECUTE FUNCTION protect_redemption_picking();
CREATE FUNCTION verify_redemption_picking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; o record; j record; t record;
BEGIN
 IF TG_TABLE_NAME='redemption_orders' THEN target:=NEW.id; ELSE target:=NEW.order_id; END IF;
 SELECT * INTO o FROM redemption_orders WHERE id=target;
 SELECT * INTO j FROM redemption_outbox WHERE order_id=target;
 SELECT * INTO t FROM redemption_picking_tasks WHERE order_id=target;
 IF j.version>0 AND NOT EXISTS(SELECT 1 FROM redemption_outbox_events e WHERE e.order_id=target AND e.version=j.version AND e.state=j.state AND e.attempts=j.attempts AND e.last_error_code IS NOT DISTINCT FROM j.last_error_code) THEN RAISE EXCEPTION 'Outbox transition event missing'; END IF;
 IF j.state='COMPLETED' AND (t.id IS NULL OR t.state NOT IN ('READY','CLAIMED') OR o.status<>'ACTIVE') THEN RAISE EXCEPTION 'Completed outbox requires active picking task'; END IF;
 IF t.id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM redemption_picking_events e WHERE e.task_id=t.id AND e.action='CREATED') OR
   (t.state='READY' AND (o.status<>'ACTIVE' OR j.state<>'COMPLETED')) OR
   (t.state='CLAIMED' AND (o.status<>'ACTIVE' OR j.state<>'COMPLETED' OR NOT EXISTS(SELECT 1 FROM redemption_picking_events e WHERE e.task_id=t.id AND e.action='CLAIMED' AND e.actor_id=t.owner_id))) OR
   (t.state='CANCELED' AND (o.status<>'CANCELED' OR j.state<>'CANCELED' OR NOT EXISTS(SELECT 1 FROM redemption_picking_events e WHERE e.task_id=t.id AND e.action='CANCELED' AND e.consumer_actor_id=o.user_id))) THEN RAISE EXCEPTION 'Picking task, order, outbox and immutable events disagree'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER redemption_picking_consistency AFTER INSERT OR UPDATE ON redemption_picking_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_picking();
CREATE CONSTRAINT TRIGGER redemption_picking_event_consistency AFTER INSERT ON redemption_picking_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_picking();
CREATE CONSTRAINT TRIGGER redemption_job_event_consistency AFTER INSERT ON redemption_outbox_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_picking();
CREATE CONSTRAINT TRIGGER redemption_job_picking_consistency AFTER INSERT OR UPDATE ON redemption_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_picking();
CREATE CONSTRAINT TRIGGER redemption_order_picking_consistency AFTER INSERT OR UPDATE ON redemption_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_picking();

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
 NOT EXISTS(SELECT 1 FROM redemption_outbox WHERE order_id=target AND ((o.status='ACTIVE' AND state IN ('PENDING','LEASED','RETRY','FAILED','COMPLETED')) OR (o.status='CANCELED' AND state='CANCELED'))) OR
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
