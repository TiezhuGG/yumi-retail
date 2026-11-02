ALTER TABLE points_grants ADD CONSTRAINT points_grants_source_unique UNIQUE(id,warehouse_id,user_id);
CREATE TABLE points_corrections (LIKE points_grants INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE points_corrections ADD PRIMARY KEY(id);
CREATE INDEX points_corrections_warehouse_id_id_idx ON points_corrections(warehouse_id,id);
ALTER TABLE points_corrections ADD COLUMN grant_id UUID NOT NULL;
ALTER TABLE points_corrections ADD FOREIGN KEY(grant_id,warehouse_id,user_id) REFERENCES points_grants(id,warehouse_id,user_id) ON DELETE RESTRICT;
ALTER TABLE points_corrections ADD FOREIGN KEY(creator_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE points_corrections ADD FOREIGN KEY(reviewer_id) REFERENCES staff(id) ON DELETE RESTRICT;
CREATE INDEX points_corrections_source_idx ON points_corrections(grant_id,status);
CREATE TRIGGER points_correction_guard BEFORE INSERT OR UPDATE OR DELETE ON points_corrections FOR EACH ROW EXECUTE FUNCTION points_grant_guard();
CREATE TRIGGER points_correction_source_immutable BEFORE UPDATE ON points_corrections FOR EACH ROW WHEN(OLD.grant_id IS DISTINCT FROM NEW.grant_id) EXECUTE FUNCTION points_immutable();
CREATE FUNCTION points_correction_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source points_grants%ROWTYPE; used NUMERIC;
BEGIN
 SELECT * INTO source FROM points_grants WHERE id=NEW.grant_id FOR UPDATE;
 IF source.status<>'APPROVED' THEN RAISE EXCEPTION 'correction source must be approved'; END IF;
 SELECT COALESCE(SUM(amount),0) INTO used FROM points_corrections WHERE grant_id=NEW.grant_id AND status IN ('SUBMITTED','APPROVED');
 IF used>source.amount THEN RAISE EXCEPTION 'correction exceeds original grant'; END IF;
 IF NEW.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM points_ledger WHERE action_key='CORRECTION:'||NEW.id::text AND user_id=NEW.user_id AND delta=-NEW.amount AND actor_id=NEW.reviewer_id) THEN RAISE EXCEPTION 'correction requires negative ledger evidence'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER points_correction_evidence AFTER INSERT OR UPDATE ON points_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION points_correction_evidence();
