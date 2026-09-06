CREATE TABLE profile_assignments_existing (
  binding_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('default','isolated','preserve','existing')),
  origin TEXT NOT NULL CHECK(origin IN ('server','imported','adopted')),
  local_home TEXT, launcher_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  desired_revision INTEGER NOT NULL CHECK(typeof(desired_revision)='integer' AND desired_revision>=0),
  applied_revision INTEGER NOT NULL CHECK(typeof(applied_revision)='integer' AND applied_revision>=0),
  state TEXT NOT NULL CHECK(state IN ('tracking','login_required','quota_available','quota_unavailable','apply_failed','migration_attention_required','stopped','local_selection_required')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, selection_key TEXT,
  CHECK(local_home IS NOT NULL OR mode='existing')
) STRICT;
INSERT INTO profile_assignments_existing(binding_id,account_id,name,mode,origin,local_home,launcher_name,active,desired_revision,applied_revision,state,created_at,updated_at)
  SELECT binding_id,account_id,name,mode,origin,local_home,launcher_name,active,desired_revision,applied_revision,state,created_at,updated_at FROM profile_assignments;
DROP TABLE profile_assignments;
ALTER TABLE profile_assignments_existing RENAME TO profile_assignments;
CREATE UNIQUE INDEX idx_profile_assignments_active_account ON profile_assignments(account_id) WHERE active=1;
CREATE UNIQUE INDEX idx_profile_assignments_one_default ON profile_assignments(mode) WHERE mode='default' AND active=1;
CREATE INDEX idx_profile_assignments_revision ON profile_assignments(desired_revision,applied_revision);
CREATE TABLE existing_home_selections (
  binding_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, selection_key TEXT NOT NULL,
  canonical_home TEXT NOT NULL, selected_at TEXT NOT NULL
) STRICT;
