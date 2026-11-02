CREATE TABLE points_grant_policies (
 warehouse_id UUID PRIMARY KEY REFERENCES warehouses(id) ON DELETE RESTRICT,
 enabled BOOLEAN NOT NULL DEFAULT false,
 single_limit BIGINT NOT NULL CHECK(single_limit BETWEEN 1 AND 1000000000),
 daily_limit BIGINT NOT NULL CHECK(daily_limit BETWEEN single_limit AND 1000000000),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE points_grants (
 id UUID PRIMARY KEY, warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
 user_id UUID NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 amount BIGINT NOT NULL CHECK(amount BETWEEN 1 AND 1000000000),
 reason VARCHAR(300) NOT NULL CHECK(length(trim(reason))>0),
 reference VARCHAR(120) NOT NULL CHECK(length(trim(reference))>0),
 creator_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
 reviewer_id UUID REFERENCES staff(id) ON DELETE RESTRICT,
 status VARCHAR(16) NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN ('SUBMITTED','APPROVED','REJECTED','CANCELED')),
 decision_reason VARCHAR(300), version INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 decided_at TIMESTAMPTZ(3),
 CHECK((status='SUBMITTED' AND reviewer_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL) OR
 (status<>'SUBMITTED' AND decision_reason IS NOT NULL AND reviewer_id IS NOT NULL AND decided_at IS NOT NULL AND length(trim(decision_reason))>0)),
 CHECK(status NOT IN ('APPROVED','REJECTED') OR reviewer_id<>creator_id),
 CHECK(status<>'CANCELED' OR reviewer_id=creator_id)
);
CREATE INDEX points_grants_scope_idx ON points_grants(warehouse_id,id);
CREATE FUNCTION points_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN IF NEW.status<>'SUBMITTED' THEN RAISE EXCEPTION 'grant must start submitted'; END IF; RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'grant immutable'; END IF;
 IF OLD.status<>'SUBMITTED' OR NEW.status='SUBMITTED' OR NEW.version<>OLD.version+1 OR
 ROW(NEW.id,NEW.warehouse_id,NEW.user_id,NEW.amount,NEW.reason,NEW.reference,NEW.creator_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.warehouse_id,OLD.user_id,OLD.amount,OLD.reason,OLD.reference,OLD.creator_id,OLD.created_at)
 THEN RAISE EXCEPTION 'invalid grant transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER points_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON points_grants FOR EACH ROW EXECUTE FUNCTION points_grant_guard();
CREATE FUNCTION points_grant_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM points_ledger WHERE action_key='GRANT:'||NEW.id::text AND user_id=NEW.user_id AND delta=NEW.amount AND actor_id=NEW.reviewer_id)
 THEN RAISE EXCEPTION 'approved grant requires ledger'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER points_grant_evidence AFTER INSERT OR UPDATE ON points_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION points_grant_evidence();
