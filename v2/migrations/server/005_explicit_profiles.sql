CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  reference INTEGER NOT NULL DEFAULT 0 CHECK (reference IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;
CREATE UNIQUE INDEX idx_accounts_one_reference ON accounts(reference) WHERE reference = 1 AND archived_at IS NULL;

CREATE TABLE device_account_bindings (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  codex_home_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE(device_id, account_id),
  UNIQUE(device_id, codex_home_key)
) STRICT;
CREATE INDEX idx_device_account_account ON device_account_bindings(account_id, disabled_at);

ALTER TABLE usage_events ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT;
CREATE INDEX idx_usage_events_account_occurred ON usage_events(account_id, occurred_at);

CREATE TABLE account_quota_current (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  identity_key TEXT NOT NULL,
  reporter_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL,
  plan_type TEXT,
  limit_id TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR (typeof(duration_minutes) = 'integer' AND duration_minutes > 0)),
  used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
  resets_at TEXT,
  slot TEXT,
  status TEXT NOT NULL CHECK (status IN ('available','ambiguous','unavailable')),
  PRIMARY KEY(account_id, identity_key)
) STRICT;

CREATE TABLE account_quota_snapshots (
  id INTEGER PRIMARY KEY,
  observation_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  reporter_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL,
  plan_type TEXT,
  limit_id TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR (typeof(duration_minutes) = 'integer' AND duration_minutes > 0)),
  used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
  resets_at TEXT,
  slot TEXT,
  status TEXT NOT NULL CHECK (status IN ('available','ambiguous','unavailable'))
) STRICT;
CREATE INDEX idx_account_quota_observed ON account_quota_snapshots(account_id, observed_at);
