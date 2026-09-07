-- Secret and connection URL are never stored here. Only explicitly selected labels.
CREATE TABLE hub_selections (
  binding_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  log_label TEXT NOT NULL, connection_id TEXT NOT NULL, selected_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_hub_selected_label ON hub_selections(connection_id,log_label);
