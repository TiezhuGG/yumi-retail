CREATE TABLE consumer_users (
  id UUID PRIMARY KEY,
  provider VARCHAR(16) NOT NULL CHECK (provider IN ('DEVELOPMENT')),
  subject VARCHAR(64) NOT NULL CHECK (subject IN ('customer-a','customer-b')),
  display_name VARCHAR(80) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider,subject)
);
CREATE TABLE consumer_sessions (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  auth_version INTEGER NOT NULL CHECK (auth_version >= 0),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(3) NOT NULL, revoked_at TIMESTAMPTZ(3),
  CHECK (expires_at > created_at)
);
CREATE INDEX consumer_sessions_user_id_expires_at_idx ON consumer_sessions(user_id,expires_at);
CREATE TABLE consumer_login_throttles (
  key CHAR(64) PRIMARY KEY, attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  window_started_at TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE consumer_auth_audits (
  id UUID PRIMARY KEY, user_id UUID REFERENCES consumer_users(id) ON DELETE RESTRICT,
  action VARCHAR(32) NOT NULL CHECK (action IN ('DEV_LOGIN','LOGOUT')),
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('SUCCEEDED','DENIED')),
  request_id UUID NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX consumer_auth_audits_user_id_created_at_idx ON consumer_auth_audits(user_id,created_at);
