CREATE TABLE warehouses (
  id UUID PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE staff (
  id UUID PRIMARY KEY, login_name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
  auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT staff_login_name_normalized CHECK (login_name = lower(login_name) AND length(login_name) BETWEEN 3 AND 64)
);
CREATE TABLE staff_roles (
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL CHECK (role_code IN ('SUPER_ADMIN','OPERATIONS','WAREHOUSE_MANAGER','PICKER','DISPATCHER','RIDER','CUSTOMER_SERVICE')),
  PRIMARY KEY (staff_id,role_code)
);
CREATE TABLE staff_warehouses (
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  PRIMARY KEY (staff_id,warehouse_id)
);
CREATE INDEX staff_warehouses_warehouse_id_idx ON staff_warehouses(warehouse_id);
CREATE TABLE staff_sessions (
  id UUID PRIMARY KEY, staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE, auth_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(3) NOT NULL, revoked_at TIMESTAMPTZ(3),
  CHECK (expires_at > created_at)
);
CREATE INDEX staff_sessions_staff_id_expires_at_idx ON staff_sessions(staff_id,expires_at);
CREATE TABLE staff_login_throttles (
  key CHAR(64) PRIMARY KEY, attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  window_started_at TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE auth_audit_events (
  id UUID PRIMARY KEY, actor_id UUID REFERENCES staff(id) ON DELETE RESTRICT,
  action TEXT NOT NULL, outcome TEXT NOT NULL, request_id UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_audit_events_actor_id_created_at_idx ON auth_audit_events(actor_id,created_at);
