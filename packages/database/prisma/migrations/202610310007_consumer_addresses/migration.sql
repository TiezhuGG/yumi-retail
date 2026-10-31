CREATE TABLE consumer_address_books (
 user_id UUID PRIMARY KEY REFERENCES consumer_users(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE consumer_addresses (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES consumer_address_books(user_id) ON DELETE RESTRICT,
 area_id UUID NOT NULL REFERENCES service_areas(id) ON DELETE RESTRICT,
 building_id UUID NOT NULL REFERENCES service_buildings(id) ON DELETE RESTRICT,
 payload TEXT,
 is_default BOOLEAN NOT NULL DEFAULT false,
 deleted BOOLEAN NOT NULL DEFAULT false,
 CHECK ((deleted AND payload IS NULL AND NOT is_default) OR (NOT deleted AND payload IS NOT NULL))
);
CREATE INDEX consumer_addresses_owner_idx ON consumer_addresses(user_id,deleted);
CREATE UNIQUE INDEX consumer_addresses_one_default_idx ON consumer_addresses(user_id) WHERE is_default AND NOT deleted;
CREATE TABLE consumer_address_operations (
 user_id UUID NOT NULL REFERENCES consumer_address_books(user_id) ON DELETE RESTRICT,
 key UUID NOT NULL, digest CHAR(64) NOT NULL, result JSONB NOT NULL,
 PRIMARY KEY(user_id,key)
);
CREATE TABLE consumer_address_audits (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES consumer_address_books(user_id) ON DELETE RESTRICT,
 address_id UUID NOT NULL, version INTEGER NOT NULL, action VARCHAR(16) NOT NULL,
 request_id UUID NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX consumer_address_audits_owner_idx ON consumer_address_audits(user_id,created_at);
