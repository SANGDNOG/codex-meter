ALTER TABLE quota_current RENAME TO quota_current_legacy;
ALTER TABLE quota_snapshots RENAME TO quota_snapshots_legacy;

CREATE TABLE quota_current (
  identity_key TEXT PRIMARY KEY,
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
INSERT INTO quota_current
  (identity_key,reporter_device_id,observed_at,plan_type,limit_id,duration_minutes,used_percent,resets_at,slot,status)
SELECT CASE WHEN limit_id IS NULL OR duration_minutes IS NULL OR duration_minutes <= 0 THEN '' ELSE limit_id || char(0) || duration_minutes END,
  reporter_device_id,observed_at,plan_type,
  CASE WHEN duration_minutes > 0 THEN limit_id ELSE NULL END,
  CASE WHEN duration_minutes > 0 THEN duration_minutes ELSE NULL END,
  CASE WHEN duration_minutes > 0 THEN used_percent ELSE NULL END,
  CASE WHEN duration_minutes > 0 THEN resets_at ELSE NULL END,NULL,
  CASE WHEN status IN ('available','ambiguous','unavailable') AND duration_minutes > 0 THEN status ELSE 'unavailable' END
FROM quota_current_legacy;

CREATE TABLE quota_snapshots (
  id INTEGER PRIMARY KEY,
  observation_id TEXT NOT NULL,
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
INSERT INTO quota_snapshots
  (id,observation_id,reporter_device_id,observed_at,plan_type,limit_id,duration_minutes,used_percent,resets_at,slot,status)
SELECT id,'legacy-' || id,reporter_device_id,observed_at,plan_type,
  CASE WHEN duration_minutes > 0 THEN limit_id ELSE NULL END,
  CASE WHEN duration_minutes > 0 THEN duration_minutes ELSE NULL END,
  CASE WHEN duration_minutes > 0 THEN used_percent ELSE NULL END,
  CASE WHEN duration_minutes > 0 THEN resets_at ELSE NULL END,NULL,
  CASE WHEN status IN ('available','ambiguous','unavailable') AND duration_minutes > 0 THEN status ELSE 'unavailable' END
FROM quota_snapshots_legacy;

DROP TABLE quota_current_legacy;
DROP TABLE quota_snapshots_legacy;
CREATE INDEX idx_quota_snapshots_observed ON quota_snapshots(observed_at);
CREATE INDEX idx_quota_snapshots_observation ON quota_snapshots(observation_id);
