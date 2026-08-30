CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  current_group_id TEXT REFERENCES groups(id) ON DELETE RESTRICT,
  disabled_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_devices_current_group ON devices(current_group_id);

CREATE TABLE device_group_memberships (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
) STRICT;
CREATE INDEX idx_memberships_device_interval ON device_group_memberships(device_id, valid_from, valid_until);
CREATE INDEX idx_memberships_group_interval ON device_group_memberships(group_id, valid_from, valid_until);
CREATE UNIQUE INDEX idx_memberships_one_open ON device_group_memberships(device_id) WHERE valid_until IS NULL;

CREATE TABLE device_enrollments (
  id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  group_id TEXT REFERENCES groups(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_enrollments_expires ON device_enrollments(expires_at);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  resolved_group_id TEXT REFERENCES groups(id) ON DELETE RESTRICT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR (typeof(cached_input_tokens) = 'integer' AND cached_input_tokens >= 0)),
  cache_write_input_tokens INTEGER CHECK (cache_write_input_tokens IS NULL OR (typeof(cache_write_input_tokens) = 'integer' AND cache_write_input_tokens >= 0)),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  reasoning_output_tokens INTEGER CHECK (reasoning_output_tokens IS NULL OR (typeof(reasoning_output_tokens) = 'integer' AND reasoning_output_tokens >= 0)),
  total_tokens INTEGER NOT NULL CHECK (typeof(total_tokens) = 'integer' AND total_tokens >= 0),
  model TEXT,
  reasoning_effort TEXT,
  UNIQUE (device_id, event_id)
) STRICT;
CREATE INDEX idx_usage_events_occurred ON usage_events(occurred_at);
CREATE INDEX idx_usage_events_group_occurred ON usage_events(resolved_group_id, occurred_at);
CREATE INDEX idx_usage_events_device_occurred ON usage_events(device_id, occurred_at);

CREATE TABLE usage_adjustments (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES groups(id) ON DELETE RESTRICT,
  device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
  amount_tokens INTEGER NOT NULL CHECK (typeof(amount_tokens) = 'integer' AND amount_tokens != 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_adjustments_group_occurred ON usage_adjustments(group_id, occurred_at);

CREATE TABLE quota_current (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  reporter_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL,
  plan_type TEXT,
  limit_id TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR (typeof(duration_minutes) = 'integer' AND duration_minutes >= 0)),
  used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
  resets_at TEXT,
  status TEXT NOT NULL
) STRICT;

CREATE TABLE quota_snapshots (
  id INTEGER PRIMARY KEY,
  reporter_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL,
  plan_type TEXT,
  limit_id TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR (typeof(duration_minutes) = 'integer' AND duration_minutes >= 0)),
  used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
  resets_at TEXT,
  status TEXT NOT NULL
) STRICT;
CREATE INDEX idx_quota_snapshots_observed ON quota_snapshots(observed_at);

CREATE TABLE server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
