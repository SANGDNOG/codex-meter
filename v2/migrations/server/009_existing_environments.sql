-- Keep the referenced binding table and its foreign keys intact. The original
-- checked mode column is retained as a migration-only compatibility column.
DROP INDEX idx_device_account_one_default;
DROP TRIGGER device_account_binding_period_insert;
ALTER TABLE device_account_bindings RENAME COLUMN mode TO v21_mode;
ALTER TABLE device_account_bindings ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (mode IN ('default','isolated','legacy','existing'));
UPDATE device_account_bindings SET mode=v21_mode;
ALTER TABLE device_account_bindings ADD COLUMN selection_key TEXT;
CREATE UNIQUE INDEX idx_device_account_one_default ON device_account_bindings(device_id)
  WHERE mode='default' AND disabled_at IS NULL;
CREATE TRIGGER device_account_binding_period_insert AFTER INSERT ON device_account_bindings
BEGIN
  INSERT INTO device_account_binding_periods(binding_id,valid_from,valid_until,legacy_history)
  VALUES(NEW.id,NEW.created_at,NEW.disabled_at,NEW.mode='legacy');
END;

ALTER TABLE devices ADD COLUMN existing_home_supported INTEGER NOT NULL DEFAULT 0 CHECK(existing_home_supported IN (0,1));
ALTER TABLE device_enrollments RENAME COLUMN binding_mode TO v21_binding_mode;
ALTER TABLE device_enrollments ADD COLUMN binding_mode TEXT CHECK(binding_mode IS NULL OR binding_mode IN ('default','isolated','existing'));
UPDATE device_enrollments SET binding_mode=v21_binding_mode;

CREATE TABLE configuration_profiles_existing (
  device_id TEXT NOT NULL, revision INTEGER NOT NULL,
  binding_id TEXT NOT NULL REFERENCES device_account_bindings(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('default','isolated','legacy','existing')),
  selection_key TEXT,
  PRIMARY KEY(device_id,revision,binding_id),
  FOREIGN KEY(device_id,revision) REFERENCES device_configuration_revisions(device_id,revision) ON DELETE CASCADE
) STRICT;
INSERT INTO configuration_profiles_existing(device_id,revision,binding_id,account_id,name,mode)
  SELECT device_id,revision,binding_id,account_id,name,mode FROM device_configuration_revision_profiles;
DROP TABLE device_configuration_revision_profiles;
ALTER TABLE configuration_profiles_existing RENAME TO device_configuration_revision_profiles;
CREATE INDEX idx_configuration_revision_profiles_account ON device_configuration_revision_profiles(account_id,device_id,revision);

CREATE TABLE profile_status_existing (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL REFERENCES device_account_bindings(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK(mode IN ('default','isolated','preserve','existing')),
  state TEXT NOT NULL CHECK(state IN ('tracking','login_required','quota_available','quota_unavailable','apply_failed','migration_attention_required','stopped','local_selection_required')),
  launcher_name TEXT, reported_at TEXT NOT NULL, PRIMARY KEY(device_id,binding_id)
) STRICT;
INSERT INTO profile_status_existing SELECT * FROM device_profile_status;
DROP TABLE device_profile_status;
ALTER TABLE profile_status_existing RENAME TO device_profile_status;
CREATE INDEX idx_device_profile_status_account ON device_profile_status(account_id,reported_at);
