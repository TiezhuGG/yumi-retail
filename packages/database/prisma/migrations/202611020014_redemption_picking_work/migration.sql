-- P4b: immutable real-allocation work facts; no stock, points or outbound movement.
ALTER TABLE redemption_allocations ADD UNIQUE(id,order_id);
ALTER TABLE redemption_picking_tasks DROP CONSTRAINT redemption_picking_tasks_state_check;
ALTER TABLE redemption_picking_tasks ADD CHECK(state IN ('READY','CLAIMED','CHECKED','CANCELED'));
ALTER TABLE redemption_picking_tasks DROP CONSTRAINT redemption_picking_tasks_check;
ALTER TABLE redemption_picking_tasks ADD CHECK((state IN ('CLAIMED','CHECKED') AND owner_id IS NOT NULL AND claimed_at IS NOT NULL) OR (state IN ('READY','CANCELED') AND owner_id IS NULL AND claimed_at IS NULL));
CREATE TABLE redemption_picking_work (
 id uuid PRIMARY KEY, task_id uuid NOT NULL, order_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>=2), action varchar(16) NOT NULL CHECK(action IN ('CHECK','SHORTAGE','DAMAGE','RESOLVE','COMPLETE')),
 allocation_id uuid, quantity integer, issue_id uuid UNIQUE REFERENCES redemption_picking_work(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, request_id uuid NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(task_id,order_id) REFERENCES redemption_picking_tasks(id,order_id) ON DELETE RESTRICT,
 FOREIGN KEY(allocation_id,order_id) REFERENCES redemption_allocations(id,order_id) ON DELETE RESTRICT,
 UNIQUE(task_id,version),
 CHECK((action='COMPLETE' AND allocation_id IS NULL AND quantity IS NULL AND issue_id IS NULL) OR
 (action IN ('CHECK','SHORTAGE','DAMAGE','RESOLVE') AND allocation_id IS NOT NULL AND quantity IS NOT NULL AND quantity>0 AND ((action='RESOLVE' AND issue_id IS NOT NULL) OR (action<>'RESOLVE' AND issue_id IS NULL))))
);
CREATE TRIGGER redemption_picking_work_immutable BEFORE UPDATE OR DELETE ON redemption_picking_work FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE OR REPLACE FUNCTION protect_redemption_picking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Picking task cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN IF NEW.state<>'READY' OR NEW.version<>0 OR NEW.owner_id IS NOT NULL OR NEW.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'Picking task starts ready'; END IF; RETURN NEW; END IF;
 IF (to_jsonb(NEW)-'state'-'owner_id'-'claimed_at'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'owner_id'-'claimed_at'-'version') OR NEW.version<>OLD.version+1 OR NOT
 ((OLD.state='READY' AND NEW.state IN ('CLAIMED','CANCELED')) OR (OLD.state='CLAIMED' AND NEW.state IN ('CLAIMED','CHECKED') AND NEW.owner_id=OLD.owner_id AND NEW.claimed_at=OLD.claimed_at)) THEN RAISE EXCEPTION 'Invalid picking task transition'; END IF;
 IF NEW.state IN ('CLAIMED','CHECKED') AND NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.owner_id AND s.enabled AND w.warehouse_id=NEW.warehouse_id AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER','PICKER')) THEN RAISE EXCEPTION 'Picking owner unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION protect_redemption_picking_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; reserved_row record; last_fact record;
BEGIN
 SELECT * INTO t FROM redemption_picking_tasks WHERE id=NEW.task_id FOR UPDATE;
 IF t.version<>NEW.version OR t.state<>(CASE WHEN NEW.action='COMPLETE' THEN 'CHECKED' ELSE 'CLAIMED' END) OR EXISTS(SELECT 1 FROM redemption_picking_work WHERE task_id=t.id AND action='COMPLETE') THEN RAISE EXCEPTION 'Work version or state mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.actor_id AND s.enabled AND w.warehouse_id=t.warehouse_id AND ((NEW.action='RESOLVE' AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER')) OR (NEW.action<>'RESOLVE' AND NEW.actor_id=t.owner_id AND r.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER','PICKER')))) THEN RAISE EXCEPTION 'Work actor unavailable'; END IF;
 IF NEW.version>2 AND NOT EXISTS(SELECT 1 FROM redemption_picking_work WHERE task_id=t.id AND version=NEW.version-1) THEN RAISE EXCEPTION 'Previous work fact missing'; END IF;
 IF NEW.action='COMPLETE' THEN
  IF EXISTS(SELECT 1 FROM redemption_allocations a WHERE a.order_id=t.order_id AND NOT EXISTS(SELECT 1 FROM redemption_picking_work c WHERE c.task_id=t.id AND c.allocation_id=a.id AND c.action='CHECK' AND c.version=(SELECT MAX(e.version) FROM redemption_picking_work e WHERE e.task_id=t.id AND e.allocation_id=a.id))) THEN RAISE EXCEPTION 'Every original allocation must be checked after issues'; END IF;
 ELSE
  SELECT * INTO reserved_row FROM redemption_allocations WHERE id=NEW.allocation_id AND order_id=t.order_id;
  IF reserved_row.id IS NULL OR reserved_row.release_ledger_id IS NOT NULL OR NEW.quantity>reserved_row.quantity OR (NEW.action IN ('CHECK','RESOLVE') AND NEW.quantity<>reserved_row.quantity) THEN RAISE EXCEPTION 'Original reserved quantity required'; END IF;
  SELECT * INTO last_fact FROM redemption_picking_work WHERE task_id=t.id AND allocation_id=reserved_row.id ORDER BY version DESC LIMIT 1;
  IF NEW.action='RESOLVE' THEN
   IF last_fact.id IS NULL OR last_fact.action NOT IN ('SHORTAGE','DAMAGE') OR NEW.issue_id<>last_fact.id THEN RAISE EXCEPTION 'Unresolved source issue required'; END IF;
  ELSIF last_fact.action IN ('SHORTAGE','DAMAGE') OR (NEW.action='CHECK' AND last_fact.action='CHECK') THEN RAISE EXCEPTION 'Unresolved issue or duplicate check'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_picking_work_protection BEFORE INSERT ON redemption_picking_work FOR EACH ROW EXECUTE FUNCTION protect_redemption_picking_work();
CREATE FUNCTION verify_redemption_picking_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; target uuid;
BEGIN
 IF TG_TABLE_NAME='redemption_picking_tasks' THEN target:=NEW.id; ELSE target:=NEW.task_id; END IF;
 SELECT * INTO t FROM redemption_picking_tasks WHERE id=target;
 IF t.version>=2 AND NOT EXISTS(SELECT 1 FROM redemption_picking_work WHERE task_id=t.id AND version=t.version AND ((t.state='CHECKED' AND action='COMPLETE') OR (t.state='CLAIMED' AND action<>'COMPLETE'))) THEN RAISE EXCEPTION 'Immutable work fact missing'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER redemption_picking_work_task_consistency AFTER UPDATE ON redemption_picking_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_picking_work();
CREATE CONSTRAINT TRIGGER redemption_picking_work_fact_consistency AFTER INSERT ON redemption_picking_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_redemption_picking_work();
CREATE OR REPLACE FUNCTION verify_redemption_picking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; o record; j record; t record;
BEGIN
 IF TG_TABLE_NAME='redemption_orders' THEN target:=NEW.id; ELSE target:=NEW.order_id; END IF;
 SELECT * INTO o FROM redemption_orders WHERE id=target;
 SELECT * INTO j FROM redemption_outbox WHERE order_id=target;
 SELECT * INTO t FROM redemption_picking_tasks WHERE order_id=target;
 IF j.version>0 AND NOT EXISTS(SELECT 1 FROM redemption_outbox_events e WHERE e.order_id=target AND e.version=j.version AND e.state=j.state AND e.attempts=j.attempts AND e.last_error_code IS NOT DISTINCT FROM j.last_error_code) THEN RAISE EXCEPTION 'Outbox transition event missing'; END IF;
 IF j.state='COMPLETED' AND (t.id IS NULL OR t.state NOT IN ('READY','CLAIMED','CHECKED') OR o.status<>'ACTIVE') THEN RAISE EXCEPTION 'Completed outbox requires active picking task'; END IF;
 IF t.id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM redemption_picking_events e WHERE e.task_id=t.id AND e.action='CREATED') OR
   (t.state='READY' AND (o.status<>'ACTIVE' OR j.state<>'COMPLETED')) OR
   (t.state IN ('CLAIMED','CHECKED') AND (o.status<>'ACTIVE' OR j.state<>'COMPLETED' OR NOT EXISTS(SELECT 1 FROM redemption_picking_events e WHERE e.task_id=t.id AND e.action='CLAIMED' AND e.actor_id=t.owner_id))) OR
   (t.state='CANCELED' AND (o.status<>'CANCELED' OR j.state<>'CANCELED' OR NOT EXISTS(SELECT 1 FROM redemption_picking_events e WHERE e.task_id=t.id AND e.action='CANCELED' AND e.consumer_actor_id=o.user_id))) THEN RAISE EXCEPTION 'Picking task, order, outbox and immutable events disagree'; END IF;
 END IF;
 RETURN NULL;
END $$;
