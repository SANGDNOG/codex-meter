# V2 Agent installation

## Requirements

The Server must be reachable through HTTPS and must serve the release `manifest.json` and all referenced Agent artifacts. For Docker deployment, place the five GitHub Release assets in the host's `./releases/` directory before starting Compose; `compose.v2.example.yml` mounts that directory read-only at `/releases` and sets `CODEX_METER_RELEASE_DIR=/releases`. See [V2 Server deployment](v2-deployment.md) for the tag, download, SHA-256 verification, and endpoint checks.

Before using Dashboard-generated commands, verify the manifest through the same public origin:

```sh
curl -fsS https://meter.example.com/api/v1/agent/releases/manifest.json
```

The monitored machine needs Codex CLI and its own local Codex authentication, but released Agents need **no Node.js, npm, git clone, or administrator privilege**.

## Install from the Dashboard

1. Choose **Add Device** and enter the Device name.
2. Select the Account Profile to track. Choose **Use this device's current Codex login** for the normal single-login setup, or **Add another Codex login** for a separate environment.
3. Run the displayed Linux, macOS, or Windows command.
4. If the Device page shows **Login required**, run the `codex login` or platform-specific generated launcher command shown there.

Enrollment tokens are one-time, expire after about 15 minutes, and are exchanged for a Device credential during enrollment. The permanent credential is not included in the bootstrap URL or shown in the Dashboard.

Linux/macOS use the displayed `curl ... install.sh` command; Windows uses the displayed PowerShell command. Each installer downloads `/api/v1/agent/releases/manifest.json`, selects Linux x64, macOS arm64, or Windows x64, downloads the referenced artifact from the same Server, verifies its SHA-256, enrolls without manually entering IDs, protects the credential file, and installs and starts a per-user systemd service, LaunchAgent, or least-privilege scheduled task.

If installation fails while downloading the manifest or artifact, verify that all five files exist under the Server host's `./releases/`, that `sha256sum --check SHA256SUMS` succeeds there, and that the public release endpoint returns them. Do not bypass checksum validation or build platform binaries inside the Server image.

Use the installed executable's full path for lifecycle commands: `$HOME/.local/bin/codex-meter-agent` on Linux, `$HOME/Library/Application Support/Codex Meter/codex-meter-agent` on macOS, or `$env:LOCALAPPDATA\CodexMeter\codex-meter-agent.exe` from Windows PowerShell. The `status`, `update`, and `uninstall --yes` subcommands are available. Updates are checksum-verified and atomic; Windows schedules replacement after process exit.

Uninstall removes the local Agent service, executable, configuration, and Agent database. It preserves managed Codex homes, credentials, sessions, and generated launchers, and does not remove Server usage already accepted. Use **Stop tracking** instead when only one Account Profile should stop reporting.

Never upload rollout JSONL or `auth.json` to install or debug Codex Meter.

## Account Profile environments

An Account Profile is an administrator label, not a verified provider identity. The Server declares only the profile ID, label, and environment type. It never receives a local path, executable path, provider email, or credential.

**Use this device's current Codex login** adopts the operating system's normal Codex home. The Agent sets the first-binding baseline at the current end of existing rollouts. It does not rewrite `config.toml`, inspect or change authentication files, create a managed marker, move sessions, or import old usage.

**Add another Codex login** creates a private Meter-managed home and a safe logical launcher such as `cx2`. The Agent creates the credential-store setting and ownership marker only inside that new managed home. Use the exact launcher command shown on the Device page to sign in. Meter never performs sign-in itself.

Adding or stopping an Account Profile is applied by the next Agent sync without editing `agent.json` or restarting the service. Stopping tracking leaves the Codex login, sessions, launcher, local home, Meter history, cursor, outbox, and quota history intact.

Only environments explicitly selected in the Dashboard are eligible for collection. The Agent does not scan arbitrary launchers or Codex homes. Upgrade migration imports only profiles already present in Codex Meter's local configuration.

Before a V2.0.x Agent receives its first declarative revision, revision 0 retains only the single default home already recorded in that Agent's Meter configuration. Imported explicit profiles suppress the global fallback. Applying any declarative revision 1 or later, including an empty revision, permanently disables the default fallback unless the Server explicitly binds that environment.

## Quota reporter command discovery

The installers capture an absolute `codex` command path when one is safely discoverable and store it only in the local Agent configuration as `codexExecutable`. They do not broaden the service `PATH`, and this path is never included in Agent sync payloads. Advanced command-line overrides remain available for troubleshooting, but are not part of normal onboarding.

Reporter designation is learned from a heartbeat (60 seconds by default), then quota is sent on the next sync (15 seconds by default). The documented worst case is therefore **75 seconds**. The Agent uses the existing periodic cycles and does not busy-loop.
