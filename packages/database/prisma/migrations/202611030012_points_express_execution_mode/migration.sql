ALTER TABLE redemption_orders ADD COLUMN execution_mode varchar(20) NOT NULL DEFAULT 'DEVELOPMENT' CHECK(execution_mode IN ('DEVELOPMENT','CONTROLLED','PRODUCTION'));
CREATE FUNCTION protect_redemption_execution_mode() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.execution_mode<>OLD.execution_mode THEN RAISE EXCEPTION 'Original execution mode is immutable'; END IF;
 SELECT COALESCE(snapshot->>'executionMode','DEVELOPMENT') INTO expected FROM redemption_quotes WHERE id=NEW.quote_id;
 IF NEW.execution_mode IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Original quote execution mode required'; END IF;
 IF NEW.execution_mode<>'DEVELOPMENT' AND (NEW.delivery_mode<>'EXPRESS' OR NOT EXISTS(SELECT 1 FROM consumer_users WHERE id=NEW.user_id AND provider='WECHAT')) THEN RAISE EXCEPTION 'Formal redemption requires WeChat and express shipping'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER redemption_execution_mode BEFORE INSERT OR UPDATE ON redemption_orders FOR EACH ROW EXECUTE FUNCTION protect_redemption_execution_mode();
