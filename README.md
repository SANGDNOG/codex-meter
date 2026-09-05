# Codex Meter

[Korean documentation](README.ko.md)

[![Tests](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml/badge.svg)](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Codex Meter is a self-hosted, privacy-preserving usage meter for teams that use the OpenAI Codex CLI across multiple Devices and Account Profiles.

Codex Meter V2.1 runs one background Agent on each registered Device. The Agent collects numeric token counters from explicitly selected Codex environments and sends them to one central Server. The Server provides the Dashboard, Account and Group attribution, quota observations, and historical usage.

Codex Meter is not an official OpenAI billing product, identity provider, OAuth proxy, or quota enforcement system. Account Profiles are labels managed by the Codex Meter administrator. Codex Meter does not automatically identify which provider account is signed in.

## What V2.1 provides

- One persistent Agent per registered Device, with no wrapper required for normal Codex use.
- Declarative Device configuration managed from the Dashboard and applied without editing `agent.json` or restarting the Agent.
- A simple flow for tracking the Device's current Codex login.
- Separate, isolated Codex environments for using multiple Account Profiles on one Device.
- Automatic per-user service and launcher creation on supported platforms.
- Explicit opt-in tracking: only environments selected in Codex Meter are collected.
- Per-Account, per-Device, and historical Group usage attribution.
- Read-only provider quota observations with stale and unavailable states.
- Estimated quota contribution based on locally tracked token shares.
- Crash-safe cursors, an SQLite outbox, at-least-once delivery, and Server-side deduplication.
- Zero-touch migration for environments that were already managed by Codex Meter.

## Tracking boundary

Codex Meter measures only Codex environments that an administrator explicitly binds to a Meter Account Profile on a Device.

For example, a computer may contain three launchers:

```text
cx1 -> Account A
cx2 -> Account B
cx3 -> Account C
```

If only `Personal -> cx1` is registered in Codex Meter, only that environment receives a collector, watcher, quota reporter, and Server attribution. `cx2` and `cx3` remain outside Codex Meter.

For an untracked environment, Codex Meter does not:

- scan or inspect its Codex home;
- read its authentication state;
- create a baseline or managed marker;
- modify `config.toml`, authentication, or session files;
- start a collector, watcher, or quota reporter; or
- report its path, launcher, account, or usage to the Server.

The existence of a launcher or `CODEX_HOME` directory is not consent to track it. Legacy migration imports only environments already present in Codex Meter's own local configuration.

One compatibility case is intentional: before the first declarative configuration is applied, a revision-0 V2.0.x Agent continues tracking the single default Codex home already recorded in its Meter configuration. This preserves an existing Meter-managed assignment; it is not machine-wide discovery. Imported explicit profiles take precedence over that fallback. After any declarative revision 1 or later is applied, including an empty revision, the default fallback is disabled.

## Architecture

```text
Explicitly selected Codex environment
  -> local rollout parser
  -> transactional cursor + SQLite outbox
  -> HTTPS Agent sync
  -> Codex Meter Server
  -> Account / Device / Group views

Codex App Server (read-only operations)
  -> normalized quota observation
  -> HTTPS Agent sync
  -> Account quota and cycle estimate
```

The Agent watches active and archived rollout files and periodically reconciles them. It parses only allowlisted `token_count.lastUsage` fields. Cursor advancement and outbox insertion are one transaction. Stable event IDs and a Server uniqueness constraint prevent duplicate counting during retries or restarts.

The Server is a single Node.js 24.15+ process serving the Dashboard and `/api/v1/**`. It stores data in a WAL-mode SQLite database with versioned migrations. Run only one Server process against a database.

See [V2 architecture](docs/v2-architecture.md) for data and attribution semantics.

## Supported platforms

| Component | Supported environment |
| --- | --- |
| Server | Docker with Node.js 24.15+, or Node.js 24.15+ directly |
| Agent | Linux x64 |
| Agent | macOS arm64 |
| Agent | Windows x64 |

Released Agents are self-contained executables. Monitored computers need the Codex CLI, but do not need a global Node.js installation, npm, or a repository checkout.

## User onboarding

Normal onboarding takes at most four actions:

1. Select **Add Device** in the Dashboard.
2. Select the Account Profile to track and the login type.
3. Run the displayed installation command.
4. If the Device reports **Login required**, run the exact login command shown on its detail page.

The user does not enter Account UUIDs, create a `CODEX_HOME`, edit JSON, copy binding IDs, or restart a service manually.

### Use this Device's current Codex login

Choose this for the normal one-login setup. The Server declares the Account Profile but does not receive a local path. The Agent adopts the operating system's default Codex home.

At the first binding, the Agent records the current end of every existing rollout as its baseline. Historical usage is not imported. Only events written after the binding are attributed to the selected Account Profile.

The Agent does not modify the adopted home's `config.toml`, authentication files, sessions, or directory ownership, and it does not create a managed marker there.

### Add another Codex login

Choose this when the same Device needs another explicitly tracked Account Profile. The Agent creates:

- a private Meter-managed Codex home;
- a managed ownership marker inside that home;
- the required credential-store configuration;
- a safe logical launcher such as `cx2`; and
- the collector, watcher, and quota reporter for that assignment.

The Device page displays commands for each supported operating system when authentication is required. Use the command for that Device:

```sh
# Linux
"$HOME/.local/bin/cx2" login

# macOS
"$HOME/Library/Application Support/Codex Meter/cx2" login
```

```powershell
# Windows PowerShell
& "$env:LOCALAPPDATA\CodexMeter\cx2.ps1" login
```

Codex Meter never signs in automatically and never asks for or copies provider credentials.

### Add, rebind, and stop tracking

Adding an Account Profile or stopping tracking creates a new desired configuration revision. A running Agent applies it during its next sync. Healthy existing assignments continue while a failed revision is reported as `apply_failed`.

**Stop tracking** stops future collection, watching, and quota reporting for that binding. It does not delete the local Codex login, Codex home, launcher, sessions, historical Meter usage, cursor, pending outbox records, or quota history.

If an Account Profile is rebound, events before the transition remain attributed to the previous binding. The new binding starts at the transition baseline and does not reassign old usage.

## Dashboard states

The Device page is the control center for tracked Account Profiles. It distinguishes:

- waiting for the Agent;
- applying configuration;
- tracking;
- login required;
- quota unavailable;
- Agent offline;
- configuration apply failed; and
- stop tracking pending.

The Account page shows measured usage, current quota, registered Device coverage, Device breakdown, historical Group attribution, and current-cycle estimates. A failed configuration does not hide assignments that remain active under the last-known-good revision.

## Server deployment

### Requirements

- Docker with Compose, or Node.js 24.15 or newer.
- A persistent directory or volume for `/data/meter.db`.
- A public HTTPS origin for enrollment and Agent sync.
- All five files from one `v2-agent-*` GitHub Release in the release directory.
- A long, unique administrator password supplied through the environment.

### Download one complete Agent release

Do not mix a manifest and binaries from different releases. The following staging commands target a Linux Server host or WSL:

```sh
mkdir -p releases
cd releases
release_url='https://github.com/SANGDNOG/codex-meter/releases/download/v2-agent-2.1.1'
for asset in \
  manifest.json \
  SHA256SUMS \
  codex-meter-agent-linux-x64 \
  codex-meter-agent-windows-x64.exe \
  codex-meter-agent-macos-arm64
do
  curl -fSLO "$release_url/$asset"
done
sha256sum --check SHA256SUMS
cd ..
chmod 755 releases
chmod 644 releases/*
```

All three binary checks must report `OK` before deployment.

On a macOS Server host, use `shasum -a 256 -c SHA256SUMS` instead of `sha256sum --check SHA256SUMS`. On a native Windows Server host, use WSL for the block above or validate every binary against the corresponding value in `SHA256SUMS` with PowerShell `Get-FileHash -Algorithm SHA256` before starting the Server.

### Start with Docker Compose

```sh
cp compose.v2.example.yml compose.yml
export CODEX_METER_ADMIN_PASSWORD='replace-with-a-long-random-password'
export CODEX_METER_SERVER_URL='https://meter.example.com'
export CODEX_METER_TRUSTED_PROXIES='127.0.0.1,::1'
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/v1/health
curl -fsS http://127.0.0.1:3000/api/v1/agent/releases/manifest.json
```

The example binds port 3000 to loopback, mounts the SQLite volume at `/data`, and mounts `./releases` read-only at `/releases`.

Place a trusted HTTPS reverse proxy in front of the Server. Preserve `Host`, set exactly `X-Forwarded-Proto: https`, and add only the proxy's exact backend source IP to `CODEX_METER_TRUSTED_PROXIES`. CIDRs and arbitrary forwarded headers are not trusted. Direct plaintext enrollment and sync requests are rejected.

See [V2 Server deployment](docs/v2-deployment.md) for release serving, backup, restore, and reverse-proxy requirements.

### Start directly with Node.js

For a direct deployment, install production dependencies and provide the same release directory explicitly:

```sh
npm ci --omit=dev
mkdir -p data releases
export CODEX_METER_ADMIN_PASSWORD='replace-with-a-long-random-password'
export CODEX_METER_SERVER_URL='https://meter.example.com'
export CODEX_METER_TRUSTED_PROXIES='127.0.0.1,::1'
export CODEX_METER_DB="$PWD/data/meter.db"
export CODEX_METER_RELEASE_DIR="$PWD/releases"
export CODEX_METER_HOST='127.0.0.1'
export CODEX_METER_PORT='3000'
node bin/v2-server.js
```

Populate and verify `releases` before starting. Run the process under one service supervisor, keep it bound behind the HTTPS reverse proxy, and never start a second process against the same SQLite database.

## Create the first Device

1. Open the public HTTPS Server URL and sign in with the administrator password.
2. Create the Account Profiles and Groups needed by your organization.
3. Open **Devices**, select **Add Device**, enter a Device name, and select one Account Profile.
4. Choose the current-login or separate-login option and create the Device.
5. Run the generated command on that Device.
6. Wait for **Tracking** or follow the exact **Login required** command.

The enrollment token in the command is short-lived and one-time. The Server stores only its hash. Successful enrollment exchanges it for a Device credential, which is stored in a permission-restricted local Agent configuration and is never placed in a URL query.

## Agent operations

The installer registers a per-user systemd service, LaunchAgent, or least-privilege Windows scheduled task. Use the installed executable's full path so the commands also work when its directory is not in `PATH`.

```sh
# Linux
"$HOME/.local/bin/codex-meter-agent" status
"$HOME/.local/bin/codex-meter-agent" update

# macOS
"$HOME/Library/Application Support/Codex Meter/codex-meter-agent" status
"$HOME/Library/Application Support/Codex Meter/codex-meter-agent" update
```

```powershell
# Windows PowerShell
& "$env:LOCALAPPDATA\CodexMeter\codex-meter-agent.exe" status
& "$env:LOCALAPPDATA\CodexMeter\codex-meter-agent.exe" update
```

`update` downloads the manifest and target binary from the configured Server, verifies SHA-256, and replaces the executable atomically. A failed verification leaves the existing executable in place.

Use **Stop tracking** when the goal is only to stop measuring an Account Profile. The `uninstall --yes` subcommand removes the Agent service, executable, configuration, and Agent database. It intentionally preserves managed Codex homes, credentials, sessions, and generated launchers so uninstall cannot delete Codex data. Those preserved environments are no longer tracked.

## Usage and attribution

Codex Meter records canonical decimal-string counters for input, cached input, optional cache-write input, output, reasoning output, and total tokens. `totalTokens` is the displayed total; the other dimensions are not added to it again.

- **Account attribution** comes from the explicit Account Profile binding at event time.
- **Device attribution** comes from the enrolled Agent credential.
- **Group attribution** uses the Device's historical Group membership at `occurredAt`, not upload time.
- **Offline usage** remains in the local outbox and is replayed after reconnection.
- **Duplicate delivery** is accepted idempotently and does not increase totals twice.

Moving a Device between Groups does not rewrite historical usage. Delayed events are assigned to the Group that owned the Device when the event occurred.

## Quota and estimated contribution

Quota reporting is read-only, optional, and separate from measured tokens. The designated Agent uses fixed Codex App Server operations to initialize, read account availability, and read rate limits. Codex Meter does not implement a token-to-provider-quota conversion.

The Dashboard shows:

- provider-reported usage and reset time;
- locally tracked tokens;
- the tracked share by Group;
- tracking coverage for explicitly registered Devices; and
- estimated quota contribution.

Estimated quota contribution allocates the provider-reported Account usage in proportion to locally tracked token usage. It is an estimate, not provider-attributed exact usage or billing data.

If tracking starts during an existing provider cycle, coverage is `partial`. Codex Meter records the provider percentage as a baseline and allocates only the percentage-point change observed after tracking began. It does not allocate the entire current provider percentage to newly tracked usage.

Computers or environments that were never registered are not included in the tracking-coverage denominator.

## Privacy and security

The local parser uses an explicit allowlist. It may transmit the event timestamp, numeric token counters, and bounded optional model or reasoning metadata. It does not persist or transmit prompts, responses, messages, source code, tool arguments, tool output, working directories, repository names, arbitrary rollout fields, OAuth credentials, or `auth.json`.

Additional protections include:

- HTTPS required for enrollment and Agent sync;
- short-lived, single-use enrollment tokens stored as hashes;
- hashed administrator passwords and Device secrets on the Server;
- permission-restricted Agent configuration and state;
- no remote filesystem paths, executables, commands, scripts, or environment variables in declarative configuration;
- fixed read-only quota operations; and
- no automatic discovery of local Codex environments.

Never upload rollout JSONL, `auth.json`, Device credentials, or administrator credentials in bug reports, CI artifacts, or support requests. See [V2 privacy model](docs/v2-privacy.md).

## Backup and recovery

Back up the production SQLite database before every Server upgrade. Use SQLite's online backup API/tool, or stop only the Codex Meter Server and copy `meter.db` with any WAL sidecars as one consistent unit. Verify backup integrity and test restoration.

A rollback across schema versions means restoring both the previous Server runtime and the matching pre-upgrade database backup. Do not run an older Server against a migrated database unless compatibility has been explicitly proven.

The Agent preserves cursors and pending outbox events across normal restarts. Do not delete `agent.db` to resolve connectivity issues.

## Troubleshooting

- **Agent inactive:** run the platform-specific `status` command shown under Agent operations, then inspect the per-user service log.
- **Login required:** run the exact command shown on the Device page. Do not copy authentication files between homes.
- **No usage increment:** installation intentionally excludes old history; allow one reconciliation and sync interval after new work.
- **Pending events:** check HTTPS, DNS, certificate trust, Device status, and Server health. The outbox retries automatically.
- **Configuration apply failed:** the previous healthy configuration remains active. Resolve the reported local filesystem or launcher conflict and allow the Agent to retry.
- **Quota unavailable or stale:** verify that an enabled registered Device is reporting and that its Codex login is usable. Do not interpret stale quota as current.
- **Server restart loop:** verify the first-start administrator password, volume ownership, disk space, and that only one Server writes the database.
- **Checksum failure:** keep the current Agent executable, verify the complete release directory, and retry. Never bypass verification.

See [V2 troubleshooting](docs/v2-troubleshooting.md) for operational details.

## Development and validation

Use Node.js 24.15 or newer:

```sh
npm ci
npm test
npm run test:v1
npm run test:v2
npm run check:syntax
sh -n v2/install/install.sh
npm audit --omit=dev
```

Release tags matching `v2-agent-*` trigger native Linux x64, Windows x64, and macOS arm64 builds, standalone executable smoke tests, deterministic manifest generation, checksum verification, and GitHub Release publication.

Real-environment validation must never copy or inspect `auth.json`. Follow the [V2 validation guide](docs/v2-validation.md).

## Legacy V1

V1 remains in the repository for compatibility testing. It uses a foreground wrapper, exactly three configured users, leases, and an optional operator-defined token quota. These behaviors do not describe V2.1. New deployments should use V2.1.

## License

[MIT](LICENSE)
