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
