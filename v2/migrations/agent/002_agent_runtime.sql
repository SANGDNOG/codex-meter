ALTER TABLE rollout_cursors ADD COLUMN classification TEXT NOT NULL DEFAULT 'baseline'
  CHECK (classification IN ('baseline','root','inherited','ambiguous'));
ALTER TABLE rollout_cursors ADD COLUMN discard_until_newline INTEGER NOT NULL DEFAULT 0
  CHECK (discard_until_newline IN (0,1));
ALTER TABLE rollout_cursors ADD COLUMN model TEXT;
ALTER TABLE rollout_cursors ADD COLUMN reasoning_effort TEXT;
ALTER TABLE rollout_cursors ADD COLUMN malformed_lines INTEGER NOT NULL DEFAULT 0 CHECK (malformed_lines >= 0);
ALTER TABLE rollout_cursors ADD COLUMN oversized_lines INTEGER NOT NULL DEFAULT 0 CHECK (oversized_lines >= 0);
ALTER TABLE rollout_cursors ADD COLUMN partial_lines INTEGER NOT NULL DEFAULT 0 CHECK (partial_lines >= 0);
ALTER TABLE rollout_cursors ADD COLUMN last_path_hash TEXT;

CREATE INDEX idx_rollout_cursors_identity ON rollout_cursors(file_identity);
