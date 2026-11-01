BEGIN;
-- Synthetic packing/dispatch facts only. No inventory or formal-order references.
CREATE TABLE picking_lab_packs (
 id UUID PRIMARY KEY,task_id UUID NOT NULL UNIQUE REFERENCES picking_lab_tasks(id) ON DELETE RESTRICT,
 actor_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,actor_name VARCHAR(80) NOT NULL,key UUID NOT NULL,
 task_version INTEGER NOT NULL CHECK(task_version=3),exception_version INTEGER NOT NULL CHECK(exception_version BETWEEN 0 AND 100),
 package_count INTEGER NOT NULL CHECK(package_count BETWEEN 1 AND 20),
 single_quantity INTEGER NOT NULL CHECK(single_quantity=2),triple_quantity INTEGER NOT NULL CHECK(triple_quantity=1),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(id,task_id)
);
CREATE TABLE picking_lab_dispatches (
 id UUID PRIMARY KEY,task_id UUID NOT NULL UNIQUE,pack_id UUID NOT NULL UNIQUE,
 actor_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,actor_name VARCHAR(80) NOT NULL,key UUID NOT NULL,
 task_version INTEGER NOT NULL CHECK(task_version=3),exception_version INTEGER NOT NULL CHECK(exception_version BETWEEN 0 AND 100),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(pack_id,task_id),
 FOREIGN KEY(pack_id,task_id) REFERENCES picking_lab_packs(id,task_id) ON DELETE RESTRICT
);
CREATE TRIGGER picking_pack_immutable BEFORE UPDATE OR DELETE ON picking_lab_packs FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER picking_dispatch_immutable BEFORE UPDATE OR DELETE ON picking_lab_dispatches FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_picking_packing_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; p record;
BEGIN
 SELECT * INTO t FROM picking_lab_tasks WHERE id=NEW.task_id FOR UPDATE;
 IF t.id IS NULL OR t.state<>'CHECKED' OR t.version<>NEW.task_version OR t.exception_version<>NEW.exception_version OR cardinality(t.checked_lines)<>2 OR NOT t.checked_lines @> ARRAY['PAPER_SINGLE','PAPER_TRIPLE']::text[] OR EXISTS(SELECT 1 FROM picking_lab_shortages WHERE task_id=t.id AND state='OPEN') THEN RAISE EXCEPTION 'Complete picking without unresolved shortage is required'; END IF;
 IF TG_TABLE_NAME='picking_lab_packs' THEN
   IF NEW.actor_id IS DISTINCT FROM t.owner_id THEN RAISE EXCEPTION 'Only picking owner can record packing'; END IF;
 ELSE
   SELECT * INTO p FROM picking_lab_packs WHERE id=NEW.pack_id AND task_id=NEW.task_id;
   IF p.id IS NULL OR p.task_version<>NEW.task_version OR p.exception_version<>NEW.exception_version THEN RAISE EXCEPTION 'Dispatch must reference the matching immutable pack'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER picking_pack_gate BEFORE INSERT ON picking_lab_packs FOR EACH ROW EXECUTE FUNCTION yumi_picking_packing_gate();
CREATE TRIGGER picking_dispatch_gate BEFORE INSERT ON picking_lab_dispatches FOR EACH ROW EXECUTE FUNCTION yumi_picking_packing_gate();
COMMIT;
