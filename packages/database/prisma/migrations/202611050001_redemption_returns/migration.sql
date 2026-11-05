-- Append-only after-sales requests and decisions. Returned goods remain separate quarantined custody.
CREATE TABLE redemption_returns (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES redemption_orders(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK(quantity>0), reason_payload text NOT NULL, request_id uuid NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX redemption_returns_order_id_id_idx ON redemption_returns(order_id,id);
CREATE TABLE redemption_return_events (
 id uuid PRIMARY KEY, return_id uuid NOT NULL REFERENCES redemption_returns(id) ON DELETE RESTRICT,
 kind varchar(12) NOT NULL CHECK(kind IN ('APPROVE','REJECT','CANCEL','RECEIVE','REFUND')),
 actor_id uuid REFERENCES staff(id) ON DELETE RESTRICT, requires_return boolean,
 quantity integer, condition varchar(24), location varchar(100), reason_payload text NOT NULL,
 ledger_id uuid UNIQUE REFERENCES points_ledger(id) ON DELETE RESTRICT, request_id uuid NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), UNIQUE(return_id,kind),
 CHECK((kind='CANCEL')=(actor_id IS NULL)),
 CHECK((kind='APPROVE')=(requires_return IS NOT NULL)),
 CHECK((kind='REFUND')=(ledger_id IS NOT NULL)),
 CHECK((kind='RECEIVE' AND quantity>0 AND condition IN ('UNOPENED','DAMAGED','WRONG_ITEM') AND length(trim(location))>0) OR (kind<>'RECEIVE' AND quantity IS NULL AND condition IS NULL AND location IS NULL))
);
CREATE TRIGGER redemption_return_immutable BEFORE UPDATE OR DELETE ON redemption_returns FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_return_event_immutable BEFORE UPDATE OR DELETE ON redemption_return_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_redemption_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record; a record; approval record; req record;
BEGIN
 IF TG_TABLE_NAME='redemption_returns' THEN SELECT * INTO o FROM redemption_orders WHERE id=NEW.order_id FOR UPDATE;
  IF o.user_id<>NEW.user_id OR o.status<>'ACTIVE' OR o.delivery_mode<>'EXPRESS' OR NOT EXISTS(SELECT 1 FROM redemption_express_shipments WHERE order_id=o.id) OR NOT EXISTS(SELECT 1 FROM consumer_users WHERE id=NEW.user_id AND enabled) THEN RAISE EXCEPTION 'Own active shipped order required'; END IF;
  IF NEW.quantity+(SELECT COALESCE(sum(r.quantity),0) FROM redemption_returns r WHERE r.order_id=o.id AND NOT EXISTS(SELECT 1 FROM redemption_return_events e WHERE e.return_id=r.id AND e.kind IN ('REJECT','CANCEL')))>o.quantity THEN RAISE EXCEPTION 'Return quantity exceeded'; END IF;
 ELSE
  SELECT * INTO req FROM redemption_returns WHERE id=NEW.return_id;
  SELECT * INTO o FROM redemption_orders WHERE id=req.order_id FOR UPDATE;
  IF NEW.kind<>'CANCEL' AND NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND r.role_code='SUPER_ADMIN' AND w.warehouse_id=o.warehouse_id) THEN RAISE EXCEPTION 'Current scoped approver required'; END IF;
  SELECT * INTO approval FROM redemption_return_events WHERE return_id=req.id AND kind='APPROVE';
  IF NEW.kind IN ('APPROVE','REJECT','CANCEL') AND EXISTS(SELECT 1 FROM redemption_return_events WHERE return_id=req.id AND kind IN ('APPROVE','REJECT','CANCEL')) THEN RAISE EXCEPTION 'Decision already recorded'; END IF;
  IF NEW.kind IN ('RECEIVE','REFUND') AND approval.id IS NULL THEN RAISE EXCEPTION 'Approval required'; END IF;
  IF NEW.kind='RECEIVE' AND (NOT approval.requires_return OR NEW.quantity<>req.quantity) THEN RAISE EXCEPTION 'Full approved physical return required'; END IF;
  IF NEW.kind='REFUND' THEN
   IF approval.requires_return AND NOT EXISTS(SELECT 1 FROM redemption_return_events WHERE return_id=req.id AND kind='RECEIVE') THEN RAISE EXCEPTION 'Physical return required before refund'; END IF;
   IF NOT EXISTS(SELECT 1 FROM points_ledger WHERE id=NEW.ledger_id AND user_id=o.user_id AND delta=req.quantity::bigint*o.points_price AND actor_id=NEW.actor_id AND action_key='RETURN_REFUND:'||req.id::text AND redemption_id IS NULL AND consumer_actor_id IS NULL) THEN RAISE EXCEPTION 'Exact original points refund required'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_return_source BEFORE INSERT ON redemption_returns FOR EACH ROW EXECUTE FUNCTION protect_redemption_return();
CREATE TRIGGER redemption_return_event_source BEFORE INSERT ON redemption_return_events FOR EACH ROW EXECUTE FUNCTION protect_redemption_return();
CREATE FUNCTION verify_return_refund_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action_key LIKE 'RETURN_REFUND:%' AND NOT EXISTS(SELECT 1 FROM redemption_return_events e JOIN redemption_returns r ON r.id=e.return_id JOIN redemption_orders o ON o.id=r.order_id WHERE e.ledger_id=NEW.id AND e.kind='REFUND' AND NEW.delta=r.quantity::bigint*o.points_price AND NEW.user_id=o.user_id AND NEW.actor_id=e.actor_id) THEN RAISE EXCEPTION 'Refund fact required for points entry'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER return_refund_ledger_consistency AFTER INSERT ON points_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_return_refund_ledger();
