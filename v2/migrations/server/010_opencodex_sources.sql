ALTER TABLE accounts ADD COLUMN measurement_source TEXT NOT NULL DEFAULT 'native_rollout'
  CHECK(measurement_source IN ('native_rollout','opencodex_proxy'));
ALTER TABLE devices ADD COLUMN opencodex_supported INTEGER NOT NULL DEFAULT 0 CHECK(opencodex_supported IN (0,1));
CREATE TABLE hub_profile_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  created_at TEXT NOT NULL, disabled_at TEXT,
  state TEXT NOT NULL DEFAULT 'local_selection_required'
    CHECK(state IN ('local_selection_required','tracking','unavailable','stopped'))
) STRICT;
CREATE UNIQUE INDEX idx_hub_one_reporter ON hub_profile_bindings(account_id) WHERE disabled_at IS NULL;
-- These are authoritative range summaries, NOT usage events. No usage-origin Device/Group.
CREATE TABLE hub_usage_current (
  binding_id TEXT NOT NULL REFERENCES hub_profile_bindings(id),
  range TEXT NOT NULL CHECK(range IN ('today','7d','30d','all')),
  observed_at TEXT, received_at TEXT NOT NULL, status TEXT NOT NULL,
  snapshot_json TEXT, PRIMARY KEY(binding_id,range)
) STRICT;
CREATE TABLE hub_quota_current (
  binding_id TEXT PRIMARY KEY REFERENCES hub_profile_bindings(id),
  observed_at TEXT, received_at TEXT NOT NULL, status TEXT NOT NULL, snapshot_json TEXT
) STRICT;
