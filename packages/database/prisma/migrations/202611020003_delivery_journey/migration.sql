BEGIN;
CREATE TABLE delivery_lab_journey_facts (
 id UUID PRIMARY KEY,
 assignment_id UUID NOT NULL REFERENCES delivery_lab_assignments(id) ON DELETE RESTRICT,
 kind VARCHAR(16) NOT NULL CHECK(kind IN ('START','COMPLETE')),
 key UUID NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(assignment_id,kind)
);
CREATE TRIGGER delivery_journey_immutable BEFORE UPDATE OR DELETE ON delivery_lab_journey_facts
 FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_delivery_journey_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; t record; d record;
BEGIN
 SELECT task.* INTO t FROM delivery_lab_assignments x JOIN picking_lab_dispatches dispatch ON dispatch.id=x.dispatch_id
 JOIN picking_lab_packs p ON p.id=dispatch.pack_id JOIN picking_lab_tasks task ON task.id=p.task_id
 WHERE x.id=NEW.assignment_id FOR UPDATE OF task;
 SELECT * INTO a FROM delivery_lab_assignments WHERE id=NEW.assignment_id;
 SELECT * INTO d FROM picking_lab_dispatches WHERE id=a.dispatch_id;
 IF t.id IS NULL OR t.state<>'CHECKED' OR t.version<>d.task_version OR t.exception_version<>d.exception_version
 OR EXISTS(SELECT 1 FROM picking_lab_shortages WHERE task_id=t.id AND state='OPEN')
 OR NOT EXISTS(SELECT 1 FROM delivery_lab_handoffs WHERE assignment_id=a.id) THEN
 RAISE EXCEPTION 'Valid synthetic handoff required'; END IF;
 IF NEW.kind='COMPLETE' AND NOT EXISTS(SELECT 1 FROM delivery_lab_journey_facts WHERE assignment_id=a.id AND kind='START') THEN
 RAISE EXCEPTION 'Synthetic start required before completion'; END IF;
 PERFORM 1 FROM staff WHERE id=a.rider_id AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Enabled rider required'; END IF;
 PERFORM 1 FROM staff_roles WHERE staff_id=a.rider_id AND role_code='RIDER' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rider role required'; END IF;
 PERFORM 1 FROM staff_warehouses WHERE staff_id=a.rider_id AND warehouse_id=t.warehouse_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rider warehouse required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_journey_gate BEFORE INSERT ON delivery_lab_journey_facts
 FOR EACH ROW EXECUTE FUNCTION yumi_delivery_journey_gate();
COMMIT;
