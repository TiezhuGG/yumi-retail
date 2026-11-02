BEGIN;
CREATE OR REPLACE FUNCTION yumi_delivery_assignment_gate() RETURNS trigger LANGUAGE plpgsql AS $$
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
  PERFORM 1 FROM staff WHERE id=NEW.actor_id AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Enabled assigner required'; END IF;
  PERFORM 1 FROM staff_roles WHERE staff_id=NEW.actor_id AND role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assigner manager role required'; END IF;
  PERFORM 1 FROM staff_warehouses WHERE staff_id=NEW.actor_id AND warehouse_id=t.warehouse_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assigner warehouse required'; END IF;
  RETURN NEW;
END $$;
COMMIT;
