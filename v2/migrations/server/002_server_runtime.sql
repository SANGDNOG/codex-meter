ALTER TABLE devices ADD COLUMN credential_salt TEXT;
ALTER TABLE devices ADD COLUMN removed_at TEXT;
ALTER TABLE devices ADD COLUMN agent_version TEXT;
ALTER TABLE devices ADD COLUMN codex_version TEXT;
ALTER TABLE devices ADD COLUMN health_status TEXT;
ALTER TABLE devices ADD COLUMN health_detail TEXT;

ALTER TABLE device_enrollments ADD COLUMN token_salt TEXT;
ALTER TABLE usage_adjustments ADD COLUMN created_by_session_id TEXT;

CREATE TABLE admin_auth (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);

CREATE TRIGGER usage_events_immutable_update
BEFORE UPDATE ON usage_events BEGIN
  SELECT RAISE(ABORT, 'measured usage events are immutable');
END;
CREATE TRIGGER usage_events_immutable_delete
BEFORE DELETE ON usage_events BEGIN
  SELECT RAISE(ABORT, 'measured usage events are immutable');
END;
CREATE TRIGGER usage_adjustments_immutable_update
BEFORE UPDATE ON usage_adjustments BEGIN
  SELECT RAISE(ABORT, 'usage adjustments are immutable');
END;
CREATE TRIGGER usage_adjustments_immutable_delete
BEFORE DELETE ON usage_adjustments BEGIN
  SELECT RAISE(ABORT, 'usage adjustments are immutable');
END;

INSERT INTO server_settings (key, value, updated_at)
VALUES ('timezone', 'UTC', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
