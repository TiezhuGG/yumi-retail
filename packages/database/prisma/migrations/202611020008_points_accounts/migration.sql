CREATE TABLE points_accounts (
 user_id UUID PRIMARY KEY REFERENCES consumer_users(id) ON DELETE RESTRICT,
 balance BIGINT NOT NULL DEFAULT 0 CHECK(balance>=0),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE points_ledger (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES points_accounts(user_id) ON DELETE RESTRICT,
 delta BIGINT NOT NULL CHECK(delta<>0),
 action_key VARCHAR(160) NOT NULL UNIQUE,
 reason VARCHAR(300) NOT NULL CHECK(length(trim(reason))>0),
 actor_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX points_ledger_owner_idx ON points_ledger(user_id,id);
CREATE FUNCTION points_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'points ledger is immutable'; END $$;
CREATE TRIGGER points_ledger_immutable BEFORE UPDATE OR DELETE ON points_ledger FOR EACH ROW EXECUTE FUNCTION points_immutable();
CREATE FUNCTION points_reconcile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id UUID; actual BIGINT; expected NUMERIC;
BEGIN
 owner_id := NEW.user_id;
 SELECT balance INTO actual FROM points_accounts WHERE user_id=owner_id FOR UPDATE;
 SELECT COALESCE(SUM(delta),0) INTO expected FROM points_ledger WHERE user_id=owner_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'points balance and ledger mismatch'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER points_account_reconcile AFTER INSERT OR UPDATE ON points_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION points_reconcile();
CREATE CONSTRAINT TRIGGER points_ledger_reconcile AFTER INSERT ON points_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION points_reconcile();
