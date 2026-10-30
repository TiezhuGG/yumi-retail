-- Additive: existing categories start at version zero; no category/product state rewrite.
ALTER TABLE categories ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD CONSTRAINT categories_version_nonnegative CHECK (version >= 0);
