-- P3 isolated local redemption foundation. No payment or synthetic picking linkage.
CREATE TABLE redemption_quotes (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 reward_id uuid NOT NULL REFERENCES reward_products(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL, created_at timestamptz(3) NOT NULL, expires_at timestamptz(3) NOT NULL CHECK(expires_at>created_at),
 UNIQUE(id,user_id)
);
CREATE INDEX redemption_quotes_owner_idx ON redemption_quotes(user_id,expires_at);
CREATE TABLE redemption_orders (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 quote_id uuid NOT NULL UNIQUE, reward_id uuid NOT NULL, warehouse_id uuid NOT NULL, sku_id uuid NOT NULL,
 order_no varchar(40) NOT NULL UNIQUE, status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CANCELED')),
 title varchar(120) NOT NULL, name varchar(120) NOT NULL, spec varchar(100) NOT NULL, unit varchar(16) NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000), points_price bigint NOT NULL CHECK(points_price BETWEEN 1 AND 1000000000),
 total_points bigint NOT NULL CHECK(total_points=quantity::bigint*points_price), reward_version integer NOT NULL,
 address_payload text NOT NULL, created_at timestamptz(3) NOT NULL, canceled_at timestamptz(3),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 FOREIGN KEY(quote_id,user_id) REFERENCES redemption_quotes(id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(reward_id,warehouse_id,sku_id) REFERENCES reward_products(id,warehouse_id,sku_id) ON DELETE RESTRICT,
 UNIQUE(quote_id,user_id), UNIQUE(id,warehouse_id,sku_id), CHECK((status='ACTIVE' AND canceled_at IS NULL) OR (status='CANCELED' AND canceled_at IS NOT NULL))
);
CREATE INDEX redemption_orders_owner_idx ON redemption_orders(user_id,id);
CREATE INDEX redemption_orders_scope_idx ON redemption_orders(warehouse_id,status,id);
CREATE INDEX redemption_orders_quota_idx ON redemption_orders(reward_id,user_id,status);
CREATE TABLE redemption_allocations (
 id uuid PRIMARY KEY, order_id uuid NOT NULL, warehouse_id uuid NOT NULL, sku_id uuid NOT NULL,
 lot_id uuid NOT NULL, position_id uuid NOT NULL, quantity integer NOT NULL CHECK(quantity>0),
 reserve_ledger_id uuid NOT NULL UNIQUE, release_ledger_id uuid UNIQUE,
 FOREIGN KEY(order_id,warehouse_id,sku_id) REFERENCES redemption_orders(id,warehouse_id,sku_id) ON DELETE RESTRICT,
 FOREIGN KEY(position_id,warehouse_id,sku_id,lot_id) REFERENCES stock_positions(id,warehouse_id,sku_id,lot_id) ON DELETE RESTRICT,
 FOREIGN KEY(reserve_ledger_id,warehouse_id,sku_id,lot_id) REFERENCES stock_ledger(id,warehouse_id,sku_id,lot_id) ON DELETE RESTRICT,
 FOREIGN KEY(release_ledger_id,warehouse_id,sku_id,lot_id) REFERENCES stock_ledger(id,warehouse_id,sku_id,lot_id) ON DELETE RESTRICT,
 UNIQUE(order_id,position_id)
);
CREATE TABLE redemption_outbox (
 order_id uuid PRIMARY KEY REFERENCES redemption_orders(id) ON DELETE RESTRICT,
 state varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CANCELED')),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE redemption_events (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES redemption_orders(id) ON DELETE RESTRICT,
 type varchar(32) NOT NULL CHECK(type IN ('REDEMPTION_CREATED','REDEMPTION_CANCELED')),
 consumer_actor_id uuid NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(order_id,type)
);
ALTER TABLE points_ledger ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE points_ledger ADD COLUMN consumer_actor_id uuid REFERENCES consumer_users(id) ON DELETE RESTRICT;
ALTER TABLE points_ledger ADD COLUMN redemption_id uuid REFERENCES redemption_orders(id) ON DELETE RESTRICT;
ALTER TABLE points_ledger ADD COLUMN redemption_action varchar(16);
ALTER TABLE points_ledger ADD CONSTRAINT points_ledger_actor_source CHECK(
 (actor_id IS NOT NULL AND consumer_actor_id IS NULL AND redemption_id IS NULL AND redemption_action IS NULL)
 OR (actor_id IS NULL AND consumer_actor_id IS NOT NULL AND consumer_actor_id=user_id AND redemption_id IS NOT NULL AND redemption_action IS NOT NULL AND redemption_action IN ('REDEEM','CANCEL'))
);
CREATE UNIQUE INDEX points_ledger_redemption_action_key ON points_ledger(redemption_id,redemption_action);
CREATE TRIGGER redemption_quotes_immutable BEFORE UPDATE OR DELETE ON redemption_quotes FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_events_immutable BEFORE UPDATE OR DELETE ON redemption_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_allocations_release_only BEFORE UPDATE ON redemption_allocations FOR EACH ROW EXECUTE FUNCTION yumi_order_allocation_immutable();
CREATE TRIGGER redemption_allocations_no_delete BEFORE DELETE ON redemption_allocations FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_redemption_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Redemption facts cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'status'-'canceled_at'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'canceled_at'-'version') OR OLD.status<>'ACTIVE' OR NEW.status<>'CANCELED' OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid redemption transition or snapshot change'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_orders_protection BEFORE UPDATE OR DELETE ON redemption_orders FOR EACH ROW EXECUTE FUNCTION protect_redemption_order();
CREATE FUNCTION protect_redemption_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Redemption outbox cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state<>'PENDING' OR NEW.state<>'CANCELED' THEN RAISE EXCEPTION 'Invalid redemption outbox transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_outbox_protection BEFORE UPDATE OR DELETE ON redemption_outbox FOR EACH ROW EXECUTE FUNCTION protect_redemption_outbox();
CREATE FUNCTION verify_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
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
 NOT EXISTS(SELECT 1 FROM redemption_outbox WHERE order_id=target AND state=CASE WHEN o.status='ACTIVE' THEN 'PENDING' ELSE 'CANCELED' END) OR
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
CREATE CONSTRAINT TRIGGER redemption_order_consistency AFTER INSERT OR UPDATE ON redemption_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption();
CREATE CONSTRAINT TRIGGER redemption_allocation_consistency AFTER INSERT OR UPDATE ON redemption_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption();
CREATE CONSTRAINT TRIGGER redemption_outbox_consistency AFTER INSERT OR UPDATE ON redemption_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption();
CREATE CONSTRAINT TRIGGER redemption_event_consistency AFTER INSERT ON redemption_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption();
CREATE CONSTRAINT TRIGGER redemption_points_consistency AFTER INSERT ON points_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption();
CREATE FUNCTION verify_redemption_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; p record;
BEGIN
 IF TG_TABLE_NAME='reward_products' THEN target:=NEW.id; ELSE target:=NEW.reward_id; END IF;
 SELECT * INTO p FROM reward_products WHERE id=target FOR UPDATE;
 IF (SELECT COALESCE(SUM(quantity),0) FROM redemption_orders WHERE reward_id=target AND status='ACTIVE')>p.total_quota OR EXISTS(SELECT user_id FROM redemption_orders WHERE reward_id=target AND status='ACTIVE' GROUP BY user_id HAVING SUM(quantity)>p.per_user_limit) THEN RAISE EXCEPTION 'Redemption quota exceeded'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER redemption_quota_check AFTER INSERT OR UPDATE ON redemption_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_quota();
CREATE CONSTRAINT TRIGGER reward_quota_check AFTER INSERT OR UPDATE ON reward_products DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_quota();
