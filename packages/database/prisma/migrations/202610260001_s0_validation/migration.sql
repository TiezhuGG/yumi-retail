-- S0-only validation schema. Not the production commerce/inventory data model.
CREATE TABLE validation_stock (
  id UUID PRIMARY KEY,
  label TEXT NOT NULL,
  on_hand INTEGER NOT NULL,
  reserved INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT validation_stock_nonnegative CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)
);
CREATE TABLE validation_reservation (
  id UUID PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  stock_id UUID NOT NULL REFERENCES validation_stock(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX validation_reservation_stock_idx ON validation_reservation(stock_id);
CREATE TABLE validation_ledger (
  id UUID PRIMARY KEY,
  action_key TEXT NOT NULL UNIQUE,
  stock_id UUID NOT NULL REFERENCES validation_stock(id) ON DELETE RESTRICT,
  delta_reserved INTEGER NOT NULL CHECK (delta_reserved > 0),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX validation_ledger_stock_idx ON validation_ledger(stock_id);
