CREATE TABLE redemption_delivery_resolutions (
 id uuid PRIMARY KEY, exception_id uuid NOT NULL UNIQUE REFERENCES redemption_delivery_exceptions(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, actor_name varchar(80) NOT NULL,
 reason varchar(300) NOT NULL CHECK(length(trim(reason))>0), request_id uuid NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER redemption_resolution_immutable BEFORE UPDATE OR DELETE ON redemption_delivery_resolutions FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
ALTER TABLE redemption_delivery_exceptions DROP CONSTRAINT redemption_delivery_exceptions_handoff_id_key;
ALTER TABLE redemption_delivery_exceptions DROP CONSTRAINT redemption_delivery_exceptions_handoff_id_order_id_key;
CREATE INDEX redemption_delivery_exceptions_handoff_idx ON redemption_delivery_exceptions(handoff_id);
CREATE FUNCTION protect_redemption_delivery_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record; e record; wh uuid;
BEGIN
 SELECT * INTO e FROM redemption_delivery_exceptions WHERE id=NEW.exception_id;
 SELECT * INTO h FROM redemption_handoffs WHERE id=e.handoff_id FOR UPDATE;
 SELECT t.warehouse_id INTO wh FROM redemption_shipments sh JOIN redemption_picking_tasks t ON t.id=sh.task_id JOIN redemption_orders o ON o.id=sh.order_id WHERE sh.id=h.shipment_id AND o.status='ACTIVE' AND t.state='CHECKED';
 IF wh IS NULL OR EXISTS(SELECT 1 FROM redemption_journey_facts WHERE handoff_id=h.id AND kind='COMPLETE') OR NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER') AND w.warehouse_id=wh AND s.display_name=NEW.actor_name) THEN RAISE EXCEPTION 'Scoped manager and open delivery required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_resolution_source BEFORE INSERT ON redemption_delivery_resolutions FOR EACH ROW EXECUTE FUNCTION protect_redemption_delivery_resolution();
CREATE OR REPLACE FUNCTION block_redemption_journey_exception() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM redemption_handoffs WHERE id=NEW.handoff_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM redemption_delivery_exceptions e WHERE e.handoff_id=NEW.handoff_id AND NOT EXISTS(SELECT 1 FROM redemption_delivery_resolutions r WHERE r.exception_id=e.id)) THEN RAISE EXCEPTION 'Unresolved delivery exception'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_redemption_delivery_exception() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record; wh uuid;
BEGIN
 SELECT * INTO h FROM redemption_handoffs WHERE id=NEW.handoff_id AND order_id=NEW.order_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM redemption_delivery_exceptions e WHERE e.handoff_id=NEW.handoff_id AND NOT EXISTS(SELECT 1 FROM redemption_delivery_resolutions r WHERE r.exception_id=e.id)) THEN RAISE EXCEPTION 'Only one unresolved exception'; END IF;
 IF h.id IS NULL OR h.actor_id<>NEW.actor_id OR EXISTS(SELECT 1 FROM redemption_journey_facts WHERE handoff_id=h.id AND kind='COMPLETE') THEN RAISE EXCEPTION 'Current rider receipt before completion required'; END IF;
 SELECT t.warehouse_id INTO wh FROM redemption_shipments sh JOIN redemption_picking_tasks t ON t.id=sh.task_id JOIN redemption_orders o ON o.id=sh.order_id WHERE sh.id=h.shipment_id AND o.status='ACTIVE' AND t.state='CHECKED';
 IF NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND r.role_code='RIDER' AND w.warehouse_id=wh) THEN RAISE EXCEPTION 'Current rider required'; END IF;
 RETURN NEW;
END $$;
