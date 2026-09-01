# V2 Agent installation

## Requirements

The Server must be reachable through HTTPS and must serve the release `manifest.json` and all referenced Agent artifacts. For Docker deployment, place the five GitHub Release assets in the host's `./releases/` directory before starting Compose; `compose.v2.example.yml` mounts that directory read-only at `/releases` and sets `CODEX_METER_RELEASE_DIR=/releases`. See [V2 Server deployment](v2-deployment.md) for the tag, download, SHA-256 verification, and endpoint checks.

Before using Dashboard-generated commands, verify the manifest through the same public origin:

```sh
curl -fsS https://meter.example.com/api/v1/agent/releases/manifest.json
```

The monitored machine needs Codex CLI and its own local Codex authentication, but released Agents need **no Node.js, npm, git clone, or administrator privilege**.

## Install from the Dashboard

In the Dashboard: create/select a Group, choose **Add Device**, name it, and copy the one-line command. Enrollment tokens are one-time and expire after about 15 minutes.

Linux/macOS use the displayed `curl ... install.sh` command; Windows uses the displayed PowerShell command. Each installer downloads `/api/v1/agent/releases/manifest.json`, selects Linux x64, macOS arm64, or Windows x64, downloads the referenced artifact from the same Server, verifies its SHA-256, enrolls without manually entering IDs, protects the credential file, and installs a per-user systemd service, LaunchAgent, or least-privilege scheduled task.

If installation fails while downloading the manifest or artifact, verify that all five files exist under the Server host's `./releases/`, that `sha256sum --check SHA256SUMS` succeeds there, and that the public release endpoint returns them. Do not bypass checksum validation or build platform binaries inside the Server image.

Check with `codex-meter-agent status`. Upgrade with `codex-meter-agent update`; the replacement is checksum-verified and atomic (Windows schedules replacement after process exit). Remove with `codex-meter-agent uninstall --yes`. Uninstall removes local Agent state and service, not Server usage already accepted.

Never upload rollout JSONL or `auth.json` to install or debug Codex Meter.

## V2.1 explicit local profiles

An Account in Codex Meter is an administrator-created **local profile**, not a verified OpenAI account. Create the profile in **Accounts**, then bind it to each participating device through the account-binding API using a non-secret opaque `codexHomeKey`. The key is only a local binding label; never use a path, email address, credential, or provider identifier.

Configure each Agent with a dedicated home per profile:

```json
{
  "serverUrl": "https://meter.example.com",
  "deviceId": "device-id",
  "deviceSecret": "device-secret",
  "profiles": [
    { "accountId": "server-profile-id", "name": "Work", "codexHome": "/home/me/.codex-work" },
    { "accountId": "another-profile-id", "name": "Personal", "codexHome": "/home/me/.codex-personal" }
  ]
}
```

On startup, the Agent creates each managed home privately, records a local non-secret ownership marker (`.codex-meter-profile.json`) containing only the Codex Meter profile ID, and creates or validates `config.toml` with `cli_auth_credentials_store = "file"`. The ownership marker prevents a removed profile path from later being assigned to another profile; do not delete or edit it. A conflicting credential-store setting or ownership marker stops startup. The Agent does not inspect `auth.json` and never initiates login or logout. Authenticate manually in the selected home.

Add and initialize a profile locally after the administrator creates the server binding, then generate a short launcher:

```sh
codex-meter-agent profile-add --account server-profile-id --name Work --codex-home "$HOME/.codex-profiles/work"
codex-meter-agent profile-launcher --account server-profile-id > codex-work
chmod 700 codex-work
./codex-work
```

On Windows, save the command output as a `.ps1` file and pass Codex arguments to that script. The launcher sets `CODEX_HOME` only for the spawned Codex CLI. Do not reuse a managed home for another profile; archive the old profile and create a new one instead.

Existing V2.0.1 configurations with one `codexHome` continue to collect and sync legacy events with a NULL account attribution.

## Quota reporter command discovery

The installers capture an absolute `codex` command path when one is safely discoverable and store it only in the local Agent configuration as `codexExecutable`. They do not broaden the service `PATH`, and this path is never included in Agent sync payloads. Enrollment also accepts `--codex-executable /absolute/path/to/codex`; Account Profiles may override it with the same option on `profile-add`.

Reporter designation is learned from a heartbeat (60 seconds by default), then quota is sent on the next sync (15 seconds by default). The documented worst case is therefore **75 seconds**. The Agent uses the existing periodic cycles and does not busy-loop.
