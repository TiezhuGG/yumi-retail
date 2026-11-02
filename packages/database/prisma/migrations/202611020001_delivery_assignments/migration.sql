BEGIN;
CREATE TABLE delivery_lab_assignments (
  id UUID PRIMARY KEY,
  dispatch_id UUID NOT NULL UNIQUE REFERENCES picking_lab_dispatches(id) ON DELETE RESTRICT,
  rider_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  rider_name VARCHAR(80) NOT NULL,
  actor_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  actor_name VARCHAR(80) NOT NULL,
  key UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX delivery_assignments_rider ON delivery_lab_assignments(rider_id);
CREATE TRIGGER delivery_assignment_immutable BEFORE UPDATE OR DELETE ON delivery_lab_assignments
  FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_delivery_assignment_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  SELECT task.* INTO t FROM picking_lab_dispatches d JOIN picking_lab_packs p ON p.id=d.pack_id
    JOIN picking_lab_tasks task ON task.id=p.task_id WHERE d.id=NEW.dispatch_id FOR UPDATE OF task;
  IF t.id IS NULL OR t.state<>'CHECKED' OR EXISTS(SELECT 1 FROM picking_lab_shortages WHERE task_id=t.id AND state='OPEN') THEN
    RAISE EXCEPTION 'Complete dispatched synthetic task is required';
  END IF;
  PERFORM 1 FROM staff WHERE id=NEW.rider_id AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Enabled rider is required'; END IF;
  PERFORM 1 FROM staff_roles WHERE staff_id=NEW.rider_id AND role_code='RIDER' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rider role is required'; END IF;
  PERFORM 1 FROM staff_warehouses WHERE staff_id=NEW.rider_id AND warehouse_id=t.warehouse_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rider must belong to dispatch warehouse'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_assignment_gate BEFORE INSERT ON delivery_lab_assignments
  FOR EACH ROW EXECUTE FUNCTION yumi_delivery_assignment_gate();
COMMIT;
