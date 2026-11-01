-- Independent synthetic workflow. No order, SKU, lot, position or stock foreign keys.
BEGIN;
CREATE TABLE picking_lab_tasks (
 id UUID PRIMARY KEY, warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
 creator_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, key UUID NOT NULL,
 fixture VARCHAR(16) NOT NULL DEFAULT 'FIXED_V1' CHECK(fixture='FIXED_V1'),
 state VARCHAR(16) NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','PICKING','CHECKED')),
 owner_id UUID REFERENCES staff(id) ON DELETE RESTRICT,
 checked_lines TEXT[] NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 3),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(warehouse_id,creator_id,key), UNIQUE(id,warehouse_id),
 CHECK(checked_lines <@ ARRAY['PAPER_SINGLE','PAPER_TRIPLE']::text[] AND cardinality(checked_lines)<=2 AND (cardinality(checked_lines)<2 OR checked_lines[1]<>checked_lines[2])),
 CHECK((state='READY' AND owner_id IS NULL AND version=0 AND cardinality(checked_lines)=0) OR
 (state='PICKING' AND owner_id IS NOT NULL AND cardinality(checked_lines)<2 AND version=cardinality(checked_lines)+1) OR
 (state='CHECKED' AND owner_id IS NOT NULL AND cardinality(checked_lines)=2 AND version=3))
);
CREATE INDEX picking_lab_tasks_warehouse_created_idx ON picking_lab_tasks(warehouse_id,created_at,id);
CREATE TABLE picking_lab_events (
 id UUID PRIMARY KEY,task_id UUID NOT NULL REFERENCES picking_lab_tasks(id) ON DELETE RESTRICT,
 actor_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,actor_name VARCHAR(80) NOT NULL,key UUID NOT NULL,
 action VARCHAR(16) NOT NULL CHECK(action IN ('CREATE','CLAIM','CHECK')),
 expected_version INTEGER,version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 3),
 line_id VARCHAR(24),quantity INTEGER,
 state VARCHAR(16) NOT NULL,owner_id UUID REFERENCES staff(id) ON DELETE RESTRICT,checked_lines TEXT[] NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(task_id,actor_id,key),UNIQUE(task_id,version),
 CHECK((action='CREATE' AND version=0 AND expected_version IS NULL AND line_id IS NULL AND quantity IS NULL) OR
 (action='CLAIM' AND expected_version IS NOT NULL AND expected_version=version-1 AND line_id IS NULL AND quantity IS NULL) OR
 (action='CHECK' AND expected_version IS NOT NULL AND line_id IS NOT NULL AND quantity IS NOT NULL AND expected_version=version-1 AND ((line_id='PAPER_SINGLE' AND quantity=2) OR (line_id='PAPER_TRIPLE' AND quantity=1))))
);
CREATE TRIGGER picking_lab_event_immutable BEFORE UPDATE OR DELETE ON picking_lab_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER picking_lab_task_no_delete BEFORE DELETE ON picking_lab_tasks FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_picking_lab_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'owner_id'-'checked_lines'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'owner_id'-'checked_lines'-'version') OR NEW.version<>OLD.version+1 OR OLD.state='CHECKED' THEN RAISE EXCEPTION 'Synthetic picking identity/history immutable'; END IF;
 IF OLD.state='READY' THEN
   IF NEW.state<>'PICKING' OR cardinality(NEW.checked_lines)<>0 OR NEW.owner_id IS NULL THEN RAISE EXCEPTION 'Claim required'; END IF;
 ELSE
   IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NOT NEW.checked_lines @> OLD.checked_lines OR cardinality(NEW.checked_lines)<>cardinality(OLD.checked_lines)+1 THEN RAISE EXCEPTION 'One owner and one new check required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER picking_lab_task_update BEFORE UPDATE ON picking_lab_tasks FOR EACH ROW EXECUTE FUNCTION yumi_picking_lab_update();
CREATE FUNCTION yumi_picking_lab_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; t record; e record; n integer:=0; previous_state text:=''; previous_owner uuid:=NULL; previous_lines text[]:='{}';
BEGIN
 IF TG_TABLE_NAME='picking_lab_tasks' THEN target:=NEW.id; ELSE target:=NEW.task_id; END IF;
 SELECT * INTO t FROM picking_lab_tasks WHERE id=target;
 FOR e IN SELECT * FROM picking_lab_events WHERE task_id=target ORDER BY version LOOP
   IF e.version<>n THEN RAISE EXCEPTION 'Synthetic picking event version gap'; END IF;
   IF n=0 THEN
     IF e.action<>'CREATE' OR e.actor_id<>t.creator_id OR e.key<>t.key OR e.state<>'READY' OR e.owner_id IS NOT NULL OR cardinality(e.checked_lines)<>0 THEN RAISE EXCEPTION 'Invalid synthetic creation event'; END IF;
   ELSIF e.action='CLAIM' THEN
     IF previous_state<>'READY' OR e.state<>'PICKING' OR e.owner_id IS DISTINCT FROM e.actor_id OR cardinality(e.checked_lines)<>0 THEN RAISE EXCEPTION 'Invalid synthetic claim event'; END IF;
   ELSIF e.action='CHECK' THEN
     IF previous_state<>'PICKING' OR e.actor_id IS DISTINCT FROM previous_owner OR e.owner_id IS DISTINCT FROM previous_owner OR e.line_id=ANY(previous_lines) OR NOT e.line_id=ANY(e.checked_lines) OR NOT e.checked_lines @> previous_lines OR cardinality(e.checked_lines)<>cardinality(previous_lines)+1 OR e.state<>(CASE WHEN cardinality(e.checked_lines)=2 THEN 'CHECKED' ELSE 'PICKING' END) THEN RAISE EXCEPTION 'Invalid synthetic check event'; END IF;
   ELSE RAISE EXCEPTION 'Invalid synthetic transition'; END IF;
   previous_state:=e.state;previous_owner:=e.owner_id;previous_lines:=e.checked_lines;n:=n+1;
 END LOOP;
 IF n<>t.version+1 OR previous_state<>t.state OR previous_owner IS DISTINCT FROM t.owner_id OR previous_lines IS DISTINCT FROM t.checked_lines THEN RAISE EXCEPTION 'Synthetic task must match immutable history'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER picking_lab_task_consistency AFTER INSERT OR UPDATE ON picking_lab_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_picking_lab_consistency();
CREATE CONSTRAINT TRIGGER picking_lab_event_consistency AFTER INSERT ON picking_lab_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_picking_lab_consistency();
COMMIT;
