CREATE TABLE device_account_binding_periods (
  id INTEGER PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES device_account_bindings(id) ON DELETE CASCADE,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  legacy_history INTEGER NOT NULL DEFAULT 0 CHECK (legacy_history IN (0,1))
) STRICT;
CREATE INDEX idx_binding_periods_time
  ON device_account_binding_periods(binding_id, valid_from, valid_until);
CREATE UNIQUE INDEX idx_binding_periods_one_open
  ON device_account_binding_periods(binding_id) WHERE valid_until IS NULL;

INSERT INTO device_account_binding_periods(binding_id,valid_from,valid_until,legacy_history)
SELECT id,created_at,disabled_at,mode='legacy' FROM device_account_bindings;

CREATE TRIGGER device_account_binding_period_insert
AFTER INSERT ON device_account_bindings
BEGIN
  INSERT INTO device_account_binding_periods(binding_id,valid_from,valid_until,legacy_history)
  VALUES(NEW.id,NEW.created_at,NEW.disabled_at,NEW.mode='legacy');
END;

CREATE TRIGGER device_account_binding_period_disable
AFTER UPDATE OF disabled_at ON device_account_bindings
WHEN OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL
BEGIN
  UPDATE device_account_binding_periods SET valid_until=NEW.disabled_at
  WHERE binding_id=NEW.id AND valid_until IS NULL;
END;
