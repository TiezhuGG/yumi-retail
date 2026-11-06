CREATE TABLE consumer_wechat_payers (
 user_id uuid PRIMARY KEY REFERENCES consumer_users(id) ON DELETE RESTRICT,
 app_id varchar(18) NOT NULL CHECK(app_id ~ '^wx[a-f0-9]{16}$'),
 key_id varchar(32) NOT NULL CHECK(key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
 payload varchar(512) NOT NULL CHECK(payload ~ '^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]+={0,2}$'),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 updated_at timestamptz(3) NOT NULL DEFAULT now() CHECK(updated_at>=created_at)
);
CREATE FUNCTION protect_consumer_wechat_payer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM consumer_users WHERE id=NEW.user_id AND provider='WECHAT' AND wechat_app_id=NEW.app_id) THEN
  RAISE EXCEPTION 'Verified WeChat identity and matching application required';
 END IF;
 IF TG_OP='INSERT' AND NEW.version<>0 THEN RAISE EXCEPTION 'Initial payer version must be zero'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.user_id,NEW.app_id,NEW.created_at) IS DISTINCT FROM (OLD.user_id,OLD.app_id,OLD.created_at) OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at) THEN
  RAISE EXCEPTION 'Payer source is immutable and revision must advance';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER consumer_wechat_payer_source BEFORE INSERT OR UPDATE ON consumer_wechat_payers FOR EACH ROW EXECUTE FUNCTION protect_consumer_wechat_payer();
