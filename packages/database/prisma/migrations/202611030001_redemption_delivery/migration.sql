-- P4d: immutable rider assignment and receipt of a real redemption shipment.
ALTER TABLE redemption_shipments ADD UNIQUE(id,order_id);
CREATE TABLE redemption_assignments (
 id uuid PRIMARY KEY, shipment_id uuid NOT NULL UNIQUE, order_id uuid NOT NULL UNIQUE,
 rider_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, rider_name varchar(80) NOT NULL,
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, actor_name varchar(80) NOT NULL,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(shipment_id,order_id) REFERENCES redemption_shipments(id,order_id) ON DELETE RESTRICT,
 UNIQUE(id,shipment_id,order_id)
);
CREATE INDEX redemption_assignments_rider_idx ON redemption_assignments(rider_id,shipment_id);
CREATE TABLE redemption_handoffs (
 id uuid PRIMARY KEY, assignment_id uuid NOT NULL UNIQUE, shipment_id uuid NOT NULL UNIQUE, order_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, package_count integer NOT NULL CHECK(package_count BETWEEN 1 AND 100),
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(assignment_id,shipment_id,order_id) REFERENCES redemption_assignments(id,shipment_id,order_id) ON DELETE RESTRICT,
 UNIQUE(id,order_id), UNIQUE(assignment_id,shipment_id,order_id)
);
CREATE TABLE redemption_handoff_lines (
 handoff_id uuid NOT NULL, order_id uuid NOT NULL, allocation_id uuid NOT NULL UNIQUE, quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(handoff_id,allocation_id),
 FOREIGN KEY(handoff_id,order_id) REFERENCES redemption_handoffs(id,order_id) ON DELETE RESTRICT,
 FOREIGN KEY(allocation_id,order_id) REFERENCES redemption_allocations(id,order_id) ON DELETE RESTRICT,
 UNIQUE(allocation_id,order_id)
);
CREATE TRIGGER redemption_assignments_immutable BEFORE UPDATE OR DELETE ON redemption_assignments FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_handoffs_immutable BEFORE UPDATE OR DELETE ON redemption_handoffs FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_handoff_lines_immutable BEFORE UPDATE OR DELETE ON redemption_handoff_lines FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_redemption_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wh uuid; a record; rider uuid; manager_id uuid;
BEGIN
 SELECT t.warehouse_id INTO wh FROM redemption_shipments sh JOIN redemption_picking_tasks t ON t.id=sh.task_id JOIN redemption_orders o ON o.id=t.order_id WHERE sh.id=NEW.shipment_id AND o.id=NEW.order_id AND o.status='ACTIVE' AND t.state='CHECKED';
 IF wh IS NULL THEN RAISE EXCEPTION 'Active original shipment required'; END IF;
 IF TG_TABLE_NAME='redemption_assignments' THEN rider:=NEW.rider_id; manager_id:=NEW.actor_id;
 ELSE SELECT * INTO a FROM redemption_assignments WHERE id=NEW.assignment_id; rider:=a.rider_id; manager_id:=a.actor_id;
  IF NEW.actor_id<>rider THEN RAISE EXCEPTION 'Only assigned rider can receive'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=rider AND s.enabled AND r.role_code='RIDER' AND w.warehouse_id=wh) OR
 NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=manager_id AND s.enabled AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER') AND w.warehouse_id=wh) THEN RAISE EXCEPTION 'Rider or assigning manager unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_assignment_actor BEFORE INSERT ON redemption_assignments FOR EACH ROW EXECUTE FUNCTION protect_redemption_delivery();
CREATE TRIGGER redemption_handoff_actor BEFORE INSERT ON redemption_handoffs FOR EACH ROW EXECUTE FUNCTION protect_redemption_delivery();
CREATE FUNCTION verify_redemption_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record; pk record;
BEGIN
 IF TG_TABLE_NAME='redemption_handoffs' THEN SELECT * INTO h FROM redemption_handoffs WHERE id=NEW.id;
 ELSE SELECT * INTO h FROM redemption_handoffs WHERE id=NEW.handoff_id; END IF;
 SELECT p.* INTO pk FROM redemption_shipments sh JOIN redemption_packs p ON p.id=sh.pack_id WHERE sh.id=h.shipment_id AND sh.order_id=h.order_id;
 IF pk.id IS NULL OR h.package_count<>pk.package_count OR EXISTS(SELECT 1 FROM redemption_pack_lines pl WHERE pl.pack_id=pk.id AND NOT EXISTS(SELECT 1 FROM redemption_handoff_lines hl WHERE hl.handoff_id=h.id AND hl.allocation_id=pl.allocation_id AND hl.quantity=pl.quantity)) OR EXISTS(SELECT 1 FROM redemption_handoff_lines hl WHERE hl.handoff_id=h.id AND NOT EXISTS(SELECT 1 FROM redemption_pack_lines pl WHERE pl.pack_id=pk.id AND pl.allocation_id=hl.allocation_id AND pl.quantity=hl.quantity)) THEN RAISE EXCEPTION 'Receipt must match every original packed allocation and package count'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER redemption_handoff_consistency AFTER INSERT ON redemption_handoffs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_handoff();
CREATE CONSTRAINT TRIGGER redemption_handoff_line_consistency AFTER INSERT ON redemption_handoff_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_handoff();

ALTER TABLE redemption_assignments ADD UNIQUE(shipment_id,order_id);
