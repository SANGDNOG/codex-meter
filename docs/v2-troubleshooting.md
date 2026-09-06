# V2 troubleshooting

- **Agent inactive:** run the installed Agent executable's `status` subcommand using its full platform path documented in [V2 Agent installation](v2-installation.md); inspect the per-user systemd journal, LaunchAgent error log, or scheduled-task history. Re-run the Dashboard installer only with a fresh enrollment.
- **Pending events:** keep using Codex; the outbox survives restart. Check HTTPS, DNS, certificate trust, Device disabled state, and Server health. Do not delete `agent.db` to fix connectivity.
- **No increment:** installation intentionally ignores old history; wait ~45 seconds after new work. Directories/files that are inherited or ambiguous can undercount safely. Check Codex session discovery without sharing paths or JSONL.
- **Login required:** run the exact login command displayed for that Account Profile on the Device page. Do not copy authentication files between homes.
- **Profile apply failed:** existing healthy tracking continues with the last-known-good configuration. Correct the local filesystem or launcher conflict and let the Agent retry; do not delete existing Codex data.
- **Stop tracking pending:** allow the Agent to complete another sync. Meter will stop its collector, watcher, and quota reporter, but it will not delete the Codex login, local sessions, or launcher.
- **Quota unavailable/stale:** quota is read-only and optional. Confirm one enabled Device is selected as reporter and Codex App Server is available. Stale quota must not be interpreted as current.
- **Group seems wrong:** attribution uses event time and historical memberships. Delayed offline events may correctly remain in the prior Group. Unassigned means no valid membership existed then.
- **Server restart loop:** inspect `docker compose logs`, validate the admin password on first start, volume ownership, and free disk. Do not start a second replica: SQLite is a single-service MVP.
- **Backup:** stop the service and copy `/data/meter.db` with its WAL sidecars, or use a SQLite online backup. Never substitute rollout JSONL or `auth.json` as a diagnostic backup.
- **Release/update failure:** retain the existing executable, verify manifest/artifact reachability and SHA-256, then retry. A checksum mismatch is a hard failure.

## Linux / WSL connection recovery (Agent 2.1.2)

`active (running)` confirms the process, not a successful Server connection. Run:

```sh
~/.local/bin/codex-meter-agent status --config ~/.local/state/codex-meter/agent.json
journalctl --user -u codex-meter-agent.service -n 60 --no-pager
```

Check `connection.status`, `connection.errorKind`, and `connection.lastSuccessAt`.
`http_400` with `invalid_configuration_revision` can mean that credentials for a
new Device were paired with the previous Device's database. Updating alone does
not reset that state. Do not delete the database or reassign its pending events
to a different Device. Preserve the existing configuration and database before
recovering the new Device's connection.

Starting with 2.1.2, enrollment allocates an `agent-<deviceId>.db` database for each
new Device and backs up a previous configuration as `agent.json.before-enroll-*`.
Previous databases and Codex homes remain untouched. Treat configuration backups
as credentials. The Linux installer checks user systemd before consuming the token
and restarts an already-running service after enrollment.

The Agent sends a startup handshake without waiting for quota collection or the
first scheduled heartbeat. Repeated filesystem notifications are coalesced so
large Codex sessions cannot queue unbounded scans ahead of status reports.
The Dashboard distinguishes registration from the first successful Agent report;
device details keep polling through offline and online states without replacing
the page or form fields. Reload an already-open tab after a Dashboard deployment.

For multiple Codex homes, inspect `trackedProfiles` in local Agent status. It lists
the active assignments and their actual `codexHome` paths. `profiles: []` is only
the legacy manual-config list and does not mean no declarative profiles exist.
Quota `not_authenticated` concerns the selected Codex home, not Server connectivity.

Measured Group share and estimated quota contribution are not provider attribution. The contribution estimate allocates provider-reported account usage by locally tracked token share and may be incomplete when registered Devices are not reporting. There is no quota enforcement.
