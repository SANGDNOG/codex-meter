ALTER TABLE device_account_bindings ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (mode IN ('default','isolated','legacy'));
CREATE UNIQUE INDEX idx_device_account_one_default
  ON device_account_bindings(device_id)
  WHERE mode = 'default' AND disabled_at IS NULL;

ALTER TABLE devices ADD COLUMN desired_config_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(desired_config_revision) = 'integer' AND desired_config_revision >= 0);
ALTER TABLE devices ADD COLUMN applied_config_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(applied_config_revision) = 'integer' AND applied_config_revision >= 0);
ALTER TABLE devices ADD COLUMN configuration_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (configuration_status IN ('unknown','applying','healthy','apply_failed','migration_attention_required'));
ALTER TABLE devices ADD COLUMN configuration_error_kind TEXT;
ALTER TABLE devices ADD COLUMN configuration_reported_at TEXT;
ALTER TABLE devices ADD COLUMN agent_configuration_schema INTEGER
  CHECK (agent_configuration_schema IS NULL OR agent_configuration_schema = 1);
ALTER TABLE devices ADD COLUMN declarative_profiles_supported INTEGER NOT NULL DEFAULT 0
  CHECK (declarative_profiles_supported IN (0,1));
ALTER TABLE devices ADD COLUMN actual_state_supported INTEGER NOT NULL DEFAULT 0
  CHECK (actual_state_supported IN (0,1));

ALTER TABLE device_enrollments ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT;
ALTER TABLE device_enrollments ADD COLUMN binding_mode TEXT
  CHECK (binding_mode IS NULL OR binding_mode IN ('default','isolated'));

CREATE TABLE device_configuration_revisions (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  sync_interval_seconds INTEGER NOT NULL,
  heartbeat_interval_seconds INTEGER NOT NULL,
  max_batch_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(device_id, revision)
) STRICT;
CREATE TABLE device_configuration_revision_profiles (
  device_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  binding_id TEXT NOT NULL REFERENCES device_account_bindings(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('default','isolated','legacy')),
  PRIMARY KEY(device_id, revision, binding_id),
  FOREIGN KEY(device_id, revision) REFERENCES device_configuration_revisions(device_id, revision) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_configuration_revision_profiles_account
  ON device_configuration_revision_profiles(account_id, device_id, revision);

CREATE TABLE device_profile_status (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES device_account_bindings(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('default','isolated','preserve')),
  state TEXT NOT NULL CHECK (state IN ('tracking','login_required','quota_available','quota_unavailable','apply_failed','migration_attention_required','stopped')),
  launcher_name TEXT,
  reported_at TEXT NOT NULL,
  PRIMARY KEY(device_id, binding_id)
) STRICT;
CREATE INDEX idx_device_profile_status_account ON device_profile_status(account_id, reported_at);

UPDATE devices SET desired_config_revision = 1
WHERE EXISTS (SELECT 1 FROM device_account_bindings b WHERE b.device_id = devices.id AND b.disabled_at IS NULL);
INSERT INTO device_configuration_revisions(device_id,revision,schema_version,sync_interval_seconds,heartbeat_interval_seconds,max_batch_size,created_at)
SELECT id,1,1,15,60,100,updated_at FROM devices WHERE desired_config_revision = 1;
INSERT INTO device_configuration_revision_profiles(device_id,revision,binding_id,account_id,name,mode)
SELECT b.device_id,1,b.id,b.account_id,a.name,'legacy'
FROM device_account_bindings b JOIN accounts a ON a.id=b.account_id
WHERE b.disabled_at IS NULL AND a.archived_at IS NULL;
