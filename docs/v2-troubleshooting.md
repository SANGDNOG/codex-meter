# V2 troubleshooting

- **Agent inactive:** run `codex-meter-agent status`; inspect the per-user systemd journal, LaunchAgent error log, or scheduled-task history. Re-run the Dashboard installer only with a fresh enrollment.
- **Pending events:** keep using Codex; the outbox survives restart. Check HTTPS, DNS, certificate trust, Device disabled state, and Server health. Do not delete `agent.db` to fix connectivity.
- **No increment:** installation intentionally ignores old history; wait ~45 seconds after new work. Directories/files that are inherited or ambiguous can undercount safely. Check Codex session discovery without sharing paths or JSONL.
- **Quota unavailable/stale:** quota is read-only and optional. Confirm one enabled Device is selected as reporter and Codex App Server is available. Stale quota must not be interpreted as current.
- **Group seems wrong:** attribution uses event time and historical memberships. Delayed offline events may correctly remain in the prior Group. Unassigned means no valid membership existed then.
- **Server restart loop:** inspect `docker compose logs`, validate the admin password on first start, volume ownership, and free disk. Do not start a second replica: SQLite is a single-service MVP.
- **Backup:** stop the service and copy `/data/meter.db` with its WAL sidecars, or use a SQLite online backup. Never substitute rollout JSONL or `auth.json` as a diagnostic backup.
- **Release/update failure:** retain the existing executable, verify manifest/artifact reachability and SHA-256, then retry. A checksum mismatch is a hard failure.

Measured Group share is not exact OpenAI quota attribution. There is no quota enforcement or token-to-quota estimate in V2.