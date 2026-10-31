CREATE TABLE checkout_policies (
 warehouse_id UUID PRIMARY KEY REFERENCES warehouses(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 delivery_fee_cents INTEGER NOT NULL CHECK(delivery_fee_cents BETWEEN 0 AND 100000000),
 min_goods_cents INTEGER NOT NULL CHECK(min_goods_cents BETWEEN 0 AND 100000000),
 free_delivery_threshold_cents INTEGER CHECK(free_delivery_threshold_cents BETWEEN 0 AND 100000000),
 open BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE checkout_quotes (
 request_id UUID NOT NULL, id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 key UUID NOT NULL, digest CHAR(64) NOT NULL, snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMPTZ(3) NOT NULL CHECK(expires_at>created_at),
 UNIQUE(user_id,key)
);
CREATE INDEX checkout_quotes_owner_expiry_idx ON checkout_quotes(user_id,expires_at);
