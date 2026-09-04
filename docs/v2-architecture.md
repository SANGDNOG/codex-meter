# V2 architecture and data semantics

Codex Meter V2 has one background Agent per Device and one Server process. The Agent discovers active and archived rollout files, establishes EOF at installation, watches plus reconciles every ~30 seconds, parses only `token_count.lastUsage`, transactionally advances each cursor with an outbox insert, syncs about every 15 seconds, and heartbeats about every 60 seconds. Stable event IDs and `UNIQUE(device_id,event_id)` provide at-least-once delivery without double counting.

The Server uses versioned SQLite migrations, WAL, foreign keys, historical Group memberships, immutable measured events, separate auditable adjustments, password-backed administrator sessions, and device-specific credentials. Dashboard and `/api/v1/**` are served by the same process. Group attribution is resolved at event `occurredAt`, so delayed events sent after a Device move retain the old Group when appropriate. No global Agent lease exists; Devices can work simultaneously.

`totalTokens` is the displayed total. Cached input, cache-write input, output, and reasoning output are dimensions and are never added again to `totalTokens`. All token integers cross JSON as canonical decimal strings.

Account quota is separate provider information obtained with fixed read-only Codex App Server operations. Quota is optional and stale-aware. The Dashboard may estimate each Group's contribution by allocating the provider-reported account percentage in proportion to locally tracked token usage. Partial cycles use only the provider delta after the first observation. This is an explicitly labeled estimate, not provider attribution, billing data, or a token-to-quota conversion.

V2.1 configuration is declarative. The Server sends only Account Profile IDs, labels, environment modes, and revisioned runtime intervals. Local paths, executable paths, commands, credentials, and provider identities are not part of remote configuration. The Agent maps an explicitly selected current login to the OS default Codex home or creates an isolated managed home and launcher for a separate login. It never discovers additional environments.

SQLite is a single-service MVP. Run exactly one Server process against `/data/meter.db`; it is not a multi-replica database. Redis, PostgreSQL, and message queues are neither used nor required.
