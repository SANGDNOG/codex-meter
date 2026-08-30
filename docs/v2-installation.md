# V2 Agent installation

## Requirements

The Server must be reachable through HTTPS and have release `manifest.json` plus artifacts configured. The monitored machine needs Codex CLI and its own local Codex authentication, but released Agents need **no Node.js, npm, git clone, or administrator privilege**.

In the Dashboard: create/select a Group, choose **Add Device**, name it, and copy the one-line command. Enrollment tokens are one-time and expire after about 15 minutes.

Linux/macOS use the displayed `curl ... install.sh` command; Windows uses the displayed PowerShell command. The installer selects Linux x64, macOS arm64, or Windows x64, verifies SHA-256, enrolls without manually entering IDs, protects the credential file, and installs a per-user systemd service, LaunchAgent, or least-privilege scheduled task.

Check with `codex-meter-agent status`. Upgrade with `codex-meter-agent update`; the replacement is checksum-verified and atomic (Windows schedules replacement after process exit). Remove with `codex-meter-agent uninstall --yes`. Uninstall removes local Agent state and service, not Server usage already accepted.

Never upload rollout JSONL or `auth.json` to install or debug Codex Meter.