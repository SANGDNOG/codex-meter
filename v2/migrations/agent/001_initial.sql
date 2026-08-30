CREATE TABLE rollout_cursors (
  rollout_key TEXT PRIMARY KEY,
  file_identity TEXT,
  byte_offset INTEGER NOT NULL DEFAULT 0 CHECK (typeof(byte_offset) = 'integer' AND byte_offset >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE usage_outbox (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR (typeof(cached_input_tokens) = 'integer' AND cached_input_tokens >= 0)),
  cache_write_input_tokens INTEGER CHECK (cache_write_input_tokens IS NULL OR (typeof(cache_write_input_tokens) = 'integer' AND cache_write_input_tokens >= 0)),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  reasoning_output_tokens INTEGER CHECK (reasoning_output_tokens IS NULL OR (typeof(reasoning_output_tokens) = 'integer' AND reasoning_output_tokens >= 0)),
  total_tokens INTEGER NOT NULL CHECK (typeof(total_tokens) = 'integer' AND total_tokens >= 0),
  model TEXT,
  reasoning_effort TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_usage_outbox_sequence ON usage_outbox(sequence);

CREATE TABLE agent_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
