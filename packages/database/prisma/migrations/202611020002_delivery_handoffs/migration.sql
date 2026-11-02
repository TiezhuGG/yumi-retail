BEGIN;
CREATE TABLE delivery_lab_handoffs (
 id UUID PRIMARY KEY,
 assignment_id UUID NOT NULL UNIQUE REFERENCES delivery_lab_assignments(id) ON DELETE RESTRICT,
 key UUID NOT NULL,
 package_count INTEGER NOT NULL CHECK(package_count > 0),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER delivery_handoff_immutable BEFORE UPDATE OR DELETE ON delivery_lab_handoffs
 FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_delivery_handoff_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; t record; d record; expected integer;
BEGIN
 SELECT task.* INTO t FROM delivery_lab_assignments x
 JOIN picking_lab_dispatches dispatch ON dispatch.id=x.dispatch_id
 JOIN picking_lab_packs p ON p.id=dispatch.pack_id
 JOIN picking_lab_tasks task ON task.id=p.task_id WHERE x.id=NEW.assignment_id FOR UPDATE OF task;
 SELECT * INTO a FROM delivery_lab_assignments WHERE id=NEW.assignment_id;
 SELECT * INTO d FROM picking_lab_dispatches WHERE id=a.dispatch_id;
 SELECT package_count INTO expected FROM picking_lab_packs WHERE id=d.pack_id;
 IF t.id IS NULL OR t.state<>'CHECKED' OR t.version<>d.task_version OR t.exception_version<>d.exception_version
 OR NEW.package_count<>expected OR EXISTS(SELECT 1 FROM picking_lab_shortages WHERE task_id=t.id AND state='OPEN') THEN
 RAISE EXCEPTION 'Matching complete synthetic dispatch required'; END IF;
 PERFORM 1 FROM staff WHERE id=a.rider_id AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Enabled rider required'; END IF;
 PERFORM 1 FROM staff_roles WHERE staff_id=a.rider_id AND role_code='RIDER' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rider role required'; END IF;
 PERFORM 1 FROM staff_warehouses WHERE staff_id=a.rider_id AND warehouse_id=t.warehouse_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rider warehouse required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_handoff_gate BEFORE INSERT ON delivery_lab_handoffs
 FOR EACH ROW EXECUTE FUNCTION yumi_delivery_handoff_gate();
COMMIT;
