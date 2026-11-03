-- Preserve assignment facts while allowing pre-receipt withdrawal and a new assignment.
CREATE TABLE redemption_assignment_withdrawals (
 id uuid PRIMARY KEY,
 assignment_id uuid NOT NULL UNIQUE REFERENCES redemption_assignments(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
 actor_name varchar(80) NOT NULL,
 reason varchar(300) NOT NULL CHECK(length(trim(reason))>0),
 request_id uuid NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER redemption_withdrawal_immutable BEFORE UPDATE OR DELETE ON redemption_assignment_withdrawals FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
ALTER TABLE redemption_assignments DROP CONSTRAINT redemption_assignments_shipment_id_key;
ALTER TABLE redemption_assignments DROP CONSTRAINT redemption_assignments_order_id_key;
ALTER TABLE redemption_assignments DROP CONSTRAINT redemption_assignments_shipment_id_order_id_key;
CREATE INDEX redemption_assignments_shipment_id_order_id_idx ON redemption_assignments(shipment_id,order_id);
CREATE FUNCTION protect_redemption_assignment_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM redemption_shipments WHERE id=NEW.shipment_id FOR UPDATE;
 IF TG_TABLE_NAME='redemption_assignments' THEN
  IF EXISTS(SELECT 1 FROM redemption_assignments a WHERE a.shipment_id=NEW.shipment_id AND NOT EXISTS(SELECT 1 FROM redemption_assignment_withdrawals x WHERE x.assignment_id=a.id)) OR EXISTS(SELECT 1 FROM redemption_handoffs WHERE shipment_id=NEW.shipment_id) THEN RAISE EXCEPTION 'Only one current assignment before receipt'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM redemption_assignment_withdrawals WHERE assignment_id=NEW.assignment_id) THEN RAISE EXCEPTION 'Withdrawn assignment cannot receive'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_assignment_current BEFORE INSERT ON redemption_assignments FOR EACH ROW EXECUTE FUNCTION protect_redemption_assignment_current();
CREATE TRIGGER redemption_handoff_current BEFORE INSERT ON redemption_handoffs FOR EACH ROW EXECUTE FUNCTION protect_redemption_assignment_current();
CREATE FUNCTION protect_redemption_assignment_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; wh uuid;
BEGIN
 SELECT * INTO a FROM redemption_assignments WHERE id=NEW.assignment_id;
 PERFORM id FROM redemption_shipments WHERE id=a.shipment_id FOR UPDATE;
 SELECT t.warehouse_id INTO wh FROM redemption_shipments sh JOIN redemption_picking_tasks t ON t.id=sh.task_id JOIN redemption_orders o ON o.id=sh.order_id WHERE sh.id=a.shipment_id AND o.status='ACTIVE' AND t.state='CHECKED';
 IF wh IS NULL OR EXISTS(SELECT 1 FROM redemption_handoffs WHERE shipment_id=a.shipment_id) OR NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER') AND w.warehouse_id=wh AND s.display_name=NEW.actor_name) THEN RAISE EXCEPTION 'Scoped manager and unreceived original shipment required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_withdrawal_source BEFORE INSERT ON redemption_assignment_withdrawals FOR EACH ROW EXECUTE FUNCTION protect_redemption_assignment_withdrawal();
