CREATE TABLE profile_assignments (
  binding_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('default','isolated','preserve')),
  origin TEXT NOT NULL CHECK (origin IN ('server','imported')),
  local_home TEXT NOT NULL,
  launcher_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  desired_revision INTEGER NOT NULL CHECK (typeof(desired_revision) = 'integer' AND desired_revision >= 0),
  applied_revision INTEGER NOT NULL CHECK (typeof(applied_revision) = 'integer' AND applied_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('tracking','login_required','quota_available','quota_unavailable','apply_failed','migration_attention_required','stopped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_profile_assignments_active_account
  ON profile_assignments(account_id) WHERE active = 1;
CREATE UNIQUE INDEX idx_profile_assignments_one_default
  ON profile_assignments(mode) WHERE mode = 'default' AND active = 1;
CREATE INDEX idx_profile_assignments_revision
  ON profile_assignments(desired_revision, applied_revision);

INSERT INTO agent_state(key,value,updated_at)
VALUES('desired_config_revision','0',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO NOTHING;
INSERT INTO agent_state(key,value,updated_at)
VALUES('applied_config_revision','0',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO NOTHING;
INSERT INTO agent_state(key,value,updated_at)
VALUES('configuration_status','unknown',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO NOTHING;
