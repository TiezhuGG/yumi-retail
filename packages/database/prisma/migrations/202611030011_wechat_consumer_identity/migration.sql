ALTER TABLE consumer_users DROP CONSTRAINT consumer_users_provider_check;
ALTER TABLE consumer_users DROP CONSTRAINT consumer_users_subject_check;
ALTER TABLE consumer_users ADD COLUMN wechat_app_id varchar(18);
ALTER TABLE consumer_users ADD CONSTRAINT consumer_users_provider_check CHECK(provider IN ('DEVELOPMENT','WECHAT'));
ALTER TABLE consumer_users ADD CONSTRAINT consumer_users_subject_check CHECK((provider='DEVELOPMENT' AND subject IN ('customer-a','customer-b') AND wechat_app_id IS NULL) OR (provider='WECHAT' AND subject ~ '^[a-f0-9]{64}$' AND wechat_app_id ~ '^wx[a-f0-9]{16}$' AND wechat_app_id IS NOT NULL));
ALTER TABLE consumer_auth_audits DROP CONSTRAINT consumer_auth_audits_action_check;
ALTER TABLE consumer_auth_audits ADD CHECK(action IN ('DEV_LOGIN','WECHAT_LOGIN','LOGOUT'));
CREATE TABLE consumer_wechat_login_codes (
 key_hash char(64) PRIMARY KEY CHECK(key_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz(3) NOT NULL
);
CREATE INDEX consumer_wechat_login_codes_expiry ON consumer_wechat_login_codes(expires_at);
CREATE FUNCTION protect_consumer_identity_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.provider,NEW.subject,NEW.wechat_app_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.provider,OLD.subject,OLD.wechat_app_id,OLD.created_at) THEN RAISE EXCEPTION 'Consumer identity source is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER consumer_identity_source BEFORE UPDATE ON consumer_users FOR EACH ROW EXECUTE FUNCTION protect_consumer_identity_source();
