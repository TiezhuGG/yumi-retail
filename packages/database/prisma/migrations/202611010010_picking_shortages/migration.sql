BEGIN;
ALTER TABLE picking_lab_tasks ADD COLUMN exception_version INTEGER NOT NULL DEFAULT 0 CHECK(exception_version>=0 AND exception_version<=100);
ALTER TABLE picking_lab_events ADD COLUMN exception_version INTEGER NOT NULL DEFAULT 0 CHECK(exception_version>=0 AND exception_version<=100);
CREATE TABLE picking_lab_shortages (
 id UUID PRIMARY KEY,task_id UUID NOT NULL REFERENCES picking_lab_tasks(id) ON DELETE RESTRICT,
 line_id VARCHAR(24) NOT NULL CHECK(line_id IN ('PAPER_SINGLE','PAPER_TRIPLE')),
 missing_quantity INTEGER NOT NULL CHECK((line_id='PAPER_SINGLE' AND missing_quantity BETWEEN 1 AND 2) OR (line_id='PAPER_TRIPLE' AND missing_quantity=1)),
 reason VARCHAR(16) NOT NULL CHECK(reason IN ('MISSING','DAMAGED')),
 reporter_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
 state VARCHAR(16) NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RESOLVED')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version IN (0,1)),
 resolver_id UUID REFERENCES staff(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 resolved_at TIMESTAMPTZ(3),
 CHECK((state='OPEN' AND version=0 AND resolver_id IS NULL AND resolved_at IS NULL) OR (state='RESOLVED' AND version=1 AND resolver_id IS NOT NULL AND resolved_at IS NOT NULL)),
 UNIQUE(id,task_id)
);
CREATE UNIQUE INDEX picking_lab_one_open_shortage ON picking_lab_shortages(task_id,line_id) WHERE state='OPEN';
CREATE INDEX picking_lab_shortages_task_idx ON picking_lab_shortages(task_id,created_at,id);
CREATE TABLE picking_lab_shortage_events (
 id UUID PRIMARY KEY,task_id UUID NOT NULL,shortage_id UUID NOT NULL,
 actor_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,actor_name VARCHAR(80) NOT NULL,key UUID NOT NULL,
 action VARCHAR(16) NOT NULL CHECK(action IN ('REPORT','RESTORE')),
 line_id VARCHAR(24) NOT NULL,quantity INTEGER NOT NULL,reason VARCHAR(16),
 task_version INTEGER NOT NULL CHECK(task_version BETWEEN 1 AND 2),expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 expected_shortage_version INTEGER,
 revision INTEGER NOT NULL CHECK(revision=expected_revision+1 AND revision<=100),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(shortage_id,task_id) REFERENCES picking_lab_shortages(id,task_id) ON DELETE RESTRICT,
 UNIQUE(task_id,actor_id,key),UNIQUE(task_id,revision),UNIQUE(shortage_id,action),
 CHECK((action='REPORT' AND expected_shortage_version IS NULL AND reason IN ('MISSING','DAMAGED') AND ((line_id='PAPER_SINGLE' AND quantity BETWEEN 1 AND 2) OR (line_id='PAPER_TRIPLE' AND quantity=1))) OR
 (action='RESTORE' AND expected_shortage_version IS NOT NULL AND expected_shortage_version=0 AND reason IS NULL AND ((line_id='PAPER_SINGLE' AND quantity=2) OR (line_id='PAPER_TRIPLE' AND quantity=1))))
);
CREATE TRIGGER picking_shortage_event_immutable BEFORE UPDATE OR DELETE ON picking_lab_shortage_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER picking_shortage_no_delete BEFORE DELETE ON picking_lab_shortages FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION yumi_picking_shortage_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'version'-'resolver_id'-'resolved_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'version'-'resolver_id'-'resolved_at') OR OLD.state<>'OPEN' OR NEW.state<>'RESOLVED' OR NEW.version<>1 THEN RAISE EXCEPTION 'Only first shortage restore is allowed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER picking_shortage_update BEFORE UPDATE ON picking_lab_shortages FOR EACH ROW EXECUTE FUNCTION yumi_picking_shortage_update();
CREATE OR REPLACE FUNCTION yumi_picking_lab_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'owner_id'-'checked_lines'-'version'-'exception_version') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'owner_id'-'checked_lines'-'version'-'exception_version') OR OLD.state='CHECKED' THEN RAISE EXCEPTION 'Synthetic picking identity/history immutable'; END IF;
 IF NEW.exception_version=OLD.exception_version+1 THEN
   IF OLD.state<>'PICKING' OR NEW.version<>OLD.version OR NEW.state<>OLD.state OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.checked_lines IS DISTINCT FROM OLD.checked_lines THEN RAISE EXCEPTION 'Exception revision cannot change picking progress'; END IF;
   RETURN NEW;
 END IF;
 IF NEW.exception_version<>OLD.exception_version OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Event version required'; END IF;
 IF OLD.state='READY' THEN
   IF NEW.state<>'PICKING' OR cardinality(NEW.checked_lines)<>0 OR NEW.owner_id IS NULL THEN RAISE EXCEPTION 'Claim required'; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM picking_lab_shortages WHERE task_id=OLD.id AND state='OPEN') THEN RAISE EXCEPTION 'Unresolved shortage blocks all checking'; END IF;
   IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NOT NEW.checked_lines @> OLD.checked_lines OR cardinality(NEW.checked_lines)<>cardinality(OLD.checked_lines)+1 THEN RAISE EXCEPTION 'One owner and one new check required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION yumi_picking_shortage_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; t record; s record; reported record; restored record; n integer; max_revision integer;
BEGIN
 IF TG_TABLE_NAME='picking_lab_tasks' THEN target:=NEW.id; ELSE target:=NEW.task_id; END IF;
 SELECT * INTO t FROM picking_lab_tasks WHERE id=target;
 SELECT COUNT(*),COALESCE(MAX(revision),0) INTO n,max_revision FROM picking_lab_shortage_events WHERE task_id=target;
 IF t.exception_version+(SELECT COUNT(*) FROM picking_lab_shortages WHERE task_id=target AND state='OPEN')>100 THEN RAISE EXCEPTION 'Reserve revision space for open shortages'; END IF;
 IF n<>t.exception_version OR max_revision<>n THEN RAISE EXCEPTION 'Exception revision/history must be continuous'; END IF;
 FOR s IN SELECT * FROM picking_lab_shortages WHERE task_id=target LOOP
   SELECT * INTO reported FROM picking_lab_shortage_events WHERE shortage_id=s.id AND action='REPORT';
   SELECT * INTO restored FROM picking_lab_shortage_events WHERE shortage_id=s.id AND action='RESTORE';
   IF reported.id IS NULL OR reported.actor_id<>s.reporter_id OR s.reporter_id IS DISTINCT FROM t.owner_id OR reported.line_id<>s.line_id OR reported.quantity<>s.missing_quantity OR reported.reason IS DISTINCT FROM s.reason THEN RAISE EXCEPTION 'Shortage report must match immutable event'; END IF;
   IF s.state='OPEN' THEN
     IF restored.id IS NOT NULL OR t.state<>'PICKING' OR s.line_id=ANY(t.checked_lines) THEN RAISE EXCEPTION 'Open shortage blocks picking'; END IF;
   ELSE
     IF restored.id IS NULL OR restored.actor_id IS DISTINCT FROM s.resolver_id OR restored.line_id<>s.line_id OR restored.revision<=reported.revision THEN RAISE EXCEPTION 'Shortage restore must match immutable event'; END IF;
   END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM picking_lab_events WHERE task_id=target AND exception_version>t.exception_version) THEN RAISE EXCEPTION 'Picking event exception snapshot is invalid'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER picking_task_shortage_consistency AFTER INSERT OR UPDATE ON picking_lab_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_picking_shortage_consistency();
CREATE CONSTRAINT TRIGGER picking_shortage_consistency AFTER INSERT OR UPDATE ON picking_lab_shortages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_picking_shortage_consistency();
CREATE CONSTRAINT TRIGGER picking_shortage_event_consistency AFTER INSERT ON picking_lab_shortage_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_picking_shortage_consistency();
CREATE FUNCTION yumi_picking_exception_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision integer;
BEGIN
 SELECT exception_version INTO revision FROM picking_lab_tasks WHERE id=NEW.task_id;
 IF NEW.exception_version<>revision THEN RAISE EXCEPTION 'Picking exception snapshot must be current'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER picking_exception_snapshot BEFORE INSERT ON picking_lab_events FOR EACH ROW EXECUTE FUNCTION yumi_picking_exception_snapshot();
COMMIT;
