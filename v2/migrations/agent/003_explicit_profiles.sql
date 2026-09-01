ALTER TABLE usage_outbox ADD COLUMN account_id TEXT;
CREATE INDEX idx_usage_outbox_account_sequence ON usage_outbox(account_id, sequence);
