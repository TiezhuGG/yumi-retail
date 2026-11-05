CREATE TABLE reward_carts (
 user_id uuid PRIMARY KEY REFERENCES consumer_users(id) ON DELETE RESTRICT,
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 items jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)<=20)
);
CREATE TABLE reward_cart_audits (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES reward_carts(user_id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0), action varchar(16) NOT NULL CHECK(action IN ('REPLACE','MERGE','CHECKOUT')),
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,version)
);
CREATE TRIGGER reward_cart_audit_immutable BEFORE UPDATE OR DELETE ON reward_cart_audits FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
