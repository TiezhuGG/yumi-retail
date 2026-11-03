-- A full, intact physical return ends a delivery attempt; consumed stock remains consumed.
ALTER TABLE redemption_handoffs ADD UNIQUE(id,shipment_id,order_id);
CREATE TABLE redemption_custody_returns (
 id uuid PRIMARY KEY, handoff_id uuid NOT NULL UNIQUE,
 shipment_id uuid NOT NULL, order_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, actor_name varchar(80) NOT NULL,
 reason varchar(300) NOT NULL CHECK(length(trim(reason))>0),
 package_count integer NOT NULL CHECK(package_count BETWEEN 1 AND 100),
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(handoff_id,shipment_id,order_id) REFERENCES redemption_handoffs(id,shipment_id,order_id) ON DELETE RESTRICT,
 FOREIGN KEY(shipment_id,order_id) REFERENCES redemption_shipments(id,order_id) ON DELETE RESTRICT,
 UNIQUE(id,order_id), UNIQUE(handoff_id,shipment_id,order_id)
);
CREATE INDEX redemption_custody_returns_shipment_id_idx ON redemption_custody_returns(shipment_id);
CREATE TABLE redemption_custody_return_lines (
 return_id uuid NOT NULL, order_id uuid NOT NULL, allocation_id uuid NOT NULL, quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(return_id,allocation_id),
 FOREIGN KEY(return_id,order_id) REFERENCES redemption_custody_returns(id,order_id) ON DELETE RESTRICT
);
CREATE TRIGGER redemption_custody_return_immutable BEFORE UPDATE OR DELETE ON redemption_custody_returns FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER redemption_custody_return_line_immutable BEFORE UPDATE OR DELETE ON redemption_custody_return_lines FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
ALTER TABLE redemption_handoffs DROP CONSTRAINT redemption_handoffs_shipment_id_key;
ALTER TABLE redemption_handoffs DROP CONSTRAINT redemption_handoffs_order_id_key;
ALTER TABLE redemption_handoff_lines DROP CONSTRAINT redemption_handoff_lines_allocation_id_key;
ALTER TABLE redemption_handoff_lines DROP CONSTRAINT redemption_handoff_lines_allocation_id_order_id_key;
CREATE INDEX redemption_handoff_lines_allocation_id_order_id_idx ON redemption_handoff_lines(allocation_id,order_id);
CREATE FUNCTION protect_redemption_custody_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record; wh uuid;
BEGIN
 PERFORM id FROM redemption_shipments WHERE id=NEW.shipment_id FOR UPDATE;
 SELECT * INTO h FROM redemption_handoffs WHERE id=NEW.handoff_id AND shipment_id=NEW.shipment_id AND order_id=NEW.order_id FOR UPDATE;
 SELECT t.warehouse_id INTO wh FROM redemption_shipments sh JOIN redemption_picking_tasks t ON t.id=sh.task_id JOIN redemption_orders o ON o.id=sh.order_id WHERE sh.id=NEW.shipment_id AND o.status='ACTIVE' AND t.state='CHECKED';
 IF h.id IS NULL OR wh IS NULL OR EXISTS(SELECT 1 FROM redemption_journey_facts WHERE handoff_id=h.id AND kind='COMPLETE') OR NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER') AND w.warehouse_id=wh AND s.display_name=NEW.actor_name) THEN RAISE EXCEPTION 'Scoped manager and undelivered original receipt required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_custody_return_source BEFORE INSERT ON redemption_custody_returns FOR EACH ROW EXECUTE FUNCTION protect_redemption_custody_return();
CREATE FUNCTION verify_redemption_custody_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; pk record;
BEGIN
 IF TG_TABLE_NAME='redemption_custody_returns' THEN SELECT * INTO r FROM redemption_custody_returns WHERE id=NEW.id; ELSE SELECT * INTO r FROM redemption_custody_returns WHERE id=NEW.return_id; END IF;
 SELECT p.* INTO pk FROM redemption_shipments sh JOIN redemption_packs p ON p.id=sh.pack_id WHERE sh.id=r.shipment_id AND sh.order_id=r.order_id;
 IF pk.id IS NULL OR r.package_count<>pk.package_count OR EXISTS(SELECT 1 FROM redemption_pack_lines pl WHERE pl.pack_id=pk.id AND NOT EXISTS(SELECT 1 FROM redemption_custody_return_lines rl WHERE rl.return_id=r.id AND rl.allocation_id=pl.allocation_id AND rl.quantity=pl.quantity)) OR EXISTS(SELECT 1 FROM redemption_custody_return_lines rl WHERE rl.return_id=r.id AND NOT EXISTS(SELECT 1 FROM redemption_pack_lines pl WHERE pl.pack_id=pk.id AND pl.allocation_id=rl.allocation_id AND pl.quantity=rl.quantity)) THEN RAISE EXCEPTION 'Return must match all original packed allocations and packages'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER redemption_custody_return_consistency AFTER INSERT ON redemption_custody_returns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_custody_return();
CREATE CONSTRAINT TRIGGER redemption_custody_return_line_consistency AFTER INSERT ON redemption_custody_return_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_custody_return();
CREATE OR REPLACE FUNCTION protect_redemption_assignment_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM redemption_shipments WHERE id=NEW.shipment_id FOR UPDATE;
 IF TG_TABLE_NAME='redemption_assignments' THEN
  IF EXISTS(SELECT 1 FROM redemption_assignments a WHERE a.shipment_id=NEW.shipment_id AND NOT EXISTS(SELECT 1 FROM redemption_assignment_withdrawals x WHERE x.assignment_id=a.id) AND NOT EXISTS(SELECT 1 FROM redemption_handoffs h JOIN redemption_custody_returns r ON r.handoff_id=h.id WHERE h.assignment_id=a.id)) THEN RAISE EXCEPTION 'Only one current custody assignment'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM redemption_assignment_withdrawals WHERE assignment_id=NEW.assignment_id) OR EXISTS(SELECT 1 FROM redemption_handoffs h WHERE h.shipment_id=NEW.shipment_id AND NOT EXISTS(SELECT 1 FROM redemption_custody_returns r WHERE r.handoff_id=h.id)) THEN RAISE EXCEPTION 'Current unreceived assignment required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION protect_redemption_assignment_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; wh uuid;
BEGIN
 SELECT * INTO a FROM redemption_assignments WHERE id=NEW.assignment_id;
 PERFORM id FROM redemption_shipments WHERE id=a.shipment_id FOR UPDATE;
 SELECT t.warehouse_id INTO wh FROM redemption_shipments sh JOIN redemption_picking_tasks t ON t.id=sh.task_id JOIN redemption_orders o ON o.id=sh.order_id WHERE sh.id=a.shipment_id AND o.status='ACTIVE' AND t.state='CHECKED';
 IF wh IS NULL OR EXISTS(SELECT 1 FROM redemption_handoffs WHERE assignment_id=a.id) OR NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER') AND w.warehouse_id=wh AND s.display_name=NEW.actor_name) THEN RAISE EXCEPTION 'Scoped manager and unreceived original assignment required'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION reject_returned_redemption_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE hid uuid;
BEGIN
 IF TG_TABLE_NAME='redemption_delivery_resolutions' THEN SELECT handoff_id INTO hid FROM redemption_delivery_exceptions WHERE id=NEW.exception_id; ELSE hid:=NEW.handoff_id; END IF;
 PERFORM id FROM redemption_handoffs WHERE id=hid FOR UPDATE;
 IF EXISTS(SELECT 1 FROM redemption_custody_returns WHERE handoff_id=hid) THEN RAISE EXCEPTION 'Returned delivery attempt has ended'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_journey_not_returned BEFORE INSERT ON redemption_journey_facts FOR EACH ROW EXECUTE FUNCTION reject_returned_redemption_attempt();
CREATE TRIGGER redemption_exception_not_returned BEFORE INSERT ON redemption_delivery_exceptions FOR EACH ROW EXECUTE FUNCTION reject_returned_redemption_attempt();
CREATE TRIGGER redemption_resolution_not_returned BEFORE INSERT ON redemption_delivery_resolutions FOR EACH ROW EXECUTE FUNCTION reject_returned_redemption_attempt();
