CREATE TABLE usage_dead_letters (
  event_id TEXT PRIMARY KEY,
  account_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('account_not_bound')),
  rejected_at TEXT NOT NULL
) STRICT;

CREATE TABLE profile_quota_status (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('available', 'ambiguous', 'unavailable')),
  error_kind TEXT,
  attempted_at TEXT NOT NULL
) STRICT;
