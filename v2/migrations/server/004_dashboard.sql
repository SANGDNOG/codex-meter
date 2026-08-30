ALTER TABLE device_enrollments ADD COLUMN device_id TEXT REFERENCES devices(id) ON DELETE SET NULL;
CREATE INDEX idx_enrollments_device ON device_enrollments(device_id);

INSERT INTO server_settings (key, value, updated_at)
VALUES
  ('online_threshold_seconds', '120', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('stale_threshold_seconds', '300', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
