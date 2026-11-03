-- P4e: rider assertions, separate from customer confirmation and stock/points movements.
CREATE TABLE redemption_journey_facts (
 id uuid PRIMARY KEY, handoff_id uuid NOT NULL, order_id uuid NOT NULL,
 kind varchar(12) NOT NULL CHECK(kind IN ('START','COMPLETE')),
 start_id uuid, actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(handoff_id,order_id) REFERENCES redemption_handoffs(id,order_id) ON DELETE RESTRICT,
 UNIQUE(handoff_id,kind), UNIQUE(id,handoff_id,order_id),
 FOREIGN KEY(start_id,handoff_id,order_id) REFERENCES redemption_journey_facts(id,handoff_id,order_id) ON DELETE RESTRICT,
 CHECK((kind='START' AND start_id IS NULL) OR (kind='COMPLETE' AND start_id IS NOT NULL))
);
CREATE TRIGGER redemption_journey_immutable BEFORE UPDATE OR DELETE ON redemption_journey_facts FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_redemption_journey() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record; wh uuid; a record;
BEGIN
 SELECT * INTO h FROM redemption_handoffs WHERE id=NEW.handoff_id AND order_id=NEW.order_id FOR UPDATE;
 IF h.id IS NULL OR h.actor_id<>NEW.actor_id THEN RAISE EXCEPTION 'Original rider receipt required'; END IF;
 SELECT * INTO a FROM redemption_assignments WHERE id=h.assignment_id;
 SELECT t.warehouse_id INTO wh FROM redemption_shipments sh JOIN redemption_picking_tasks t ON t.id=sh.task_id JOIN redemption_orders o ON o.id=sh.order_id WHERE sh.id=h.shipment_id AND o.id=NEW.order_id AND o.status='ACTIVE' AND t.state='CHECKED';
 IF wh IS NULL OR NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND r.role_code='RIDER' AND w.warehouse_id=wh) OR NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=a.actor_id AND s.enabled AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER') AND w.warehouse_id=wh) THEN RAISE EXCEPTION 'Journey actor or shipment unavailable'; END IF;
 IF NEW.kind='COMPLETE' AND NOT EXISTS(SELECT 1 FROM redemption_journey_facts WHERE id=NEW.start_id AND handoff_id=h.id AND order_id=NEW.order_id AND kind='START' AND actor_id=NEW.actor_id) THEN RAISE EXCEPTION 'Original rider start required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_journey_source BEFORE INSERT ON redemption_journey_facts FOR EACH ROW EXECUTE FUNCTION protect_redemption_journey();
