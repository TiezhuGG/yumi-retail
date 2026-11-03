CREATE TABLE redemption_delivery_exceptions (
 id uuid PRIMARY KEY, handoff_id uuid NOT NULL UNIQUE, order_id uuid NOT NULL,
 kind varchar(24) NOT NULL CHECK(kind IN ('CONTACT_FAILED','ADDRESS_ISSUE','DAMAGED','REFUSED','OTHER')),
 reason varchar(300) NOT NULL CHECK(length(trim(reason))>0),
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(handoff_id,order_id),
 FOREIGN KEY(handoff_id,order_id) REFERENCES redemption_handoffs(id,order_id) ON DELETE RESTRICT
);
CREATE TRIGGER redemption_delivery_exception_immutable BEFORE UPDATE OR DELETE ON redemption_delivery_exceptions FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_redemption_delivery_exception() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record; wh uuid;
BEGIN
 SELECT * INTO h FROM redemption_handoffs WHERE id=NEW.handoff_id AND order_id=NEW.order_id FOR UPDATE;
 IF h.id IS NULL OR h.actor_id<>NEW.actor_id OR EXISTS(SELECT 1 FROM redemption_journey_facts WHERE handoff_id=h.id AND kind='COMPLETE') THEN RAISE EXCEPTION 'Current rider receipt before completion required'; END IF;
 SELECT t.warehouse_id INTO wh FROM redemption_shipments sh JOIN redemption_picking_tasks t ON t.id=sh.task_id JOIN redemption_orders o ON o.id=sh.order_id WHERE sh.id=h.shipment_id AND o.status='ACTIVE' AND t.state='CHECKED';
 IF NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND r.role_code='RIDER' AND w.warehouse_id=wh) THEN RAISE EXCEPTION 'Current rider required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_delivery_exception_source BEFORE INSERT ON redemption_delivery_exceptions FOR EACH ROW EXECUTE FUNCTION protect_redemption_delivery_exception();
CREATE FUNCTION block_redemption_journey_exception() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM redemption_handoffs WHERE id=NEW.handoff_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM redemption_delivery_exceptions WHERE handoff_id=NEW.handoff_id) THEN RAISE EXCEPTION 'Unresolved delivery exception'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_journey_exception_block BEFORE INSERT ON redemption_journey_facts FOR EACH ROW EXECUTE FUNCTION block_redemption_journey_exception();
