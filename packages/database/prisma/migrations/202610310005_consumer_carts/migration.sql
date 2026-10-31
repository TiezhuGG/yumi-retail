CREATE TABLE consumer_carts (
 user_id UUID PRIMARY KEY REFERENCES consumer_users(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0)
);
-- No SKU FK: explicitly retain unavailable/deleted guest references and their unverified labels.
CREATE TABLE consumer_cart_items (
 user_id UUID NOT NULL REFERENCES consumer_carts(user_id) ON DELETE RESTRICT,
 sku_id UUID NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 200),
 selected BOOLEAN NOT NULL, name VARCHAR(120) NOT NULL CHECK(length(trim(name))>0),
 spec VARCHAR(100) NOT NULL CHECK(length(trim(spec))>0), unit VARCHAR(16) NOT NULL CHECK(length(trim(unit))>0),
 PRIMARY KEY(user_id,sku_id)
);
CREATE TABLE consumer_cart_merges (
 user_id UUID NOT NULL REFERENCES consumer_carts(user_id) ON DELETE RESTRICT,
 key UUID NOT NULL, digest CHAR(64) NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), result JSONB NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,key)
);
CREATE TABLE consumer_cart_audits (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES consumer_carts(user_id) ON DELETE RESTRICT,
 action VARCHAR(16) NOT NULL CHECK(action IN ('ADD','UPDATE','REMOVE','SELECT','MERGE')),
 version INTEGER NOT NULL CHECK(version>0), request_id UUID NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX consumer_cart_audits_user_id_created_at_idx ON consumer_cart_audits(user_id,created_at);
