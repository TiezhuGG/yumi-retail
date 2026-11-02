-- Real redemption packing and atomic consumption of original reservations. No cash/payment movement.
ALTER TABLE redemption_allocations ADD COLUMN consume_ledger_id uuid UNIQUE;
ALTER TABLE redemption_allocations ADD FOREIGN KEY(consume_ledger_id,warehouse_id,sku_id,lot_id) REFERENCES stock_ledger(id,warehouse_id,sku_id,lot_id) ON DELETE RESTRICT;
ALTER TABLE redemption_allocations ADD CHECK(release_ledger_id IS NULL OR consume_ledger_id IS NULL);
DROP TRIGGER redemption_allocations_release_only ON redemption_allocations;
CREATE FUNCTION protect_redemption_allocation_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'release_ledger_id'-'consume_ledger_id') IS DISTINCT FROM (to_jsonb(OLD)-'release_ledger_id'-'consume_ledger_id') OR OLD.release_ledger_id IS NOT NULL OR OLD.consume_ledger_id IS NOT NULL OR ((NEW.release_ledger_id IS NULL)=(NEW.consume_ledger_id IS NULL)) THEN RAISE EXCEPTION 'Only first release or consumption may settle original allocation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_allocation_settlement BEFORE UPDATE ON redemption_allocations FOR EACH ROW EXECUTE FUNCTION protect_redemption_allocation_settlement();
CREATE TABLE redemption_packs (
 id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE, order_id uuid NOT NULL UNIQUE, task_version integer NOT NULL CHECK(task_version>=2),
 package_count integer NOT NULL CHECK(package_count BETWEEN 1 AND 100),
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(task_id,order_id) REFERENCES redemption_picking_tasks(id,order_id) ON DELETE RESTRICT,
 UNIQUE(id,order_id), UNIQUE(id,task_id,order_id)
);
CREATE TABLE redemption_pack_lines (
 pack_id uuid NOT NULL, order_id uuid NOT NULL, allocation_id uuid NOT NULL UNIQUE, quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(pack_id,allocation_id),
 FOREIGN KEY(pack_id,order_id) REFERENCES redemption_packs(id,order_id) ON DELETE RESTRICT,
 FOREIGN KEY(allocation_id,order_id) REFERENCES redemption_allocations(id,order_id) ON DELETE RESTRICT
);
CREATE TABLE redemption_shipments (
 id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE, order_id uuid NOT NULL UNIQUE, pack_id uuid NOT NULL UNIQUE,
 task_version integer NOT NULL CHECK(task_version>=2), actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(pack_id,task_id,order_id) REFERENCES redemption_packs(id,task_id,order_id) ON DELETE RESTRICT
);
CREATE TRIGGER redemption_packs_immutable BEFORE UPDATE OR DELETE ON redemption_packs FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_pack_lines_immutable BEFORE UPDATE OR DELETE ON redemption_pack_lines FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_shipments_immutable BEFORE UPDATE OR DELETE ON redemption_shipments FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_redemption_packing_actor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
 SELECT * INTO t FROM redemption_picking_tasks WHERE id=NEW.task_id FOR UPDATE;
 IF t.state<>'CHECKED' OR t.version<>NEW.task_version OR NOT EXISTS(SELECT 1 FROM redemption_orders WHERE id=t.order_id AND status='ACTIVE') THEN RAISE EXCEPTION 'Current checked task required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM staff s JOIN staff_warehouses w ON w.staff_id=s.id JOIN staff_roles r ON r.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND w.warehouse_id=t.warehouse_id AND ((TG_TABLE_NAME='redemption_packs' AND NEW.actor_id=t.owner_id AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER','PICKER')) OR (TG_TABLE_NAME='redemption_shipments' AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER')))) THEN RAISE EXCEPTION 'Packing or shipment actor unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_pack_actor BEFORE INSERT ON redemption_packs FOR EACH ROW EXECUTE FUNCTION protect_redemption_packing_actor();
CREATE TRIGGER redemption_ship_actor BEFORE INSERT ON redemption_shipments FOR EACH ROW EXECUTE FUNCTION protect_redemption_packing_actor();
CREATE FUNCTION verify_redemption_packing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; t record; pk record; sh record;
BEGIN
 IF TG_TABLE_NAME='redemption_picking_tasks' THEN target:=NEW.order_id;
 ELSIF TG_TABLE_NAME='stock_ledger' THEN
  IF NEW.action_key NOT LIKE 'REDEMPTION_SHIP:%' THEN RETURN NULL; END IF;
  SELECT order_id INTO target FROM redemption_allocations WHERE consume_ledger_id=NEW.id;
  IF target IS NULL THEN RAISE EXCEPTION 'Shipment ledger must settle original allocation'; END IF;
 ELSE target:=NEW.order_id; END IF;
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
CREATE CONSTRAINT TRIGGER redemption_pack_consistency AFTER INSERT ON redemption_packs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_packing();
CREATE CONSTRAINT TRIGGER redemption_pack_line_consistency AFTER INSERT ON redemption_pack_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_packing();
CREATE CONSTRAINT TRIGGER redemption_ship_consistency AFTER INSERT ON redemption_shipments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_packing();
CREATE CONSTRAINT TRIGGER redemption_consumption_consistency AFTER INSERT OR UPDATE ON redemption_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_packing();
CREATE CONSTRAINT TRIGGER redemption_ship_ledger_consistency AFTER INSERT ON stock_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_packing();
CREATE CONSTRAINT TRIGGER redemption_pack_task_consistency AFTER UPDATE ON redemption_picking_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_packing();

ALTER TABLE redemption_packs ADD UNIQUE(task_id,order_id);
ALTER TABLE redemption_pack_lines ADD UNIQUE(allocation_id,order_id);
ALTER TABLE redemption_shipments ADD UNIQUE(pack_id,task_id,order_id);
