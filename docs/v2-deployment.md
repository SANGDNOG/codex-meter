# V2 Server deployment

## 1. Create and populate the Agent release directory

The Docker deployment serves Agent release assets from the host directory `./releases/`, mounted read-only at `/releases`. The Server does not build Agent binaries and does not download from GitHub at runtime.

Create and push the version tag from the exact validated commit:

```sh
git switch main
git pull --ff-only origin main
git tag -a v2-agent-2.1.1 -m "Codex Meter Agent 2.1.1"
git push origin v2-agent-2.1.1
```

The `v2-agent-*` tag triggers `.github/workflows/release-v2.yml`. GitHub Actions builds native `linux-x64`, `windows-x64`, and `macos-arm64` Agent binaries, creates `manifest.json` and `SHA256SUMS`, verifies the checksums, and publishes all five files as GitHub Release assets.

On a Linux Server host or WSL, download that release into `./releases/`. This is a deployment-time action; the running Server needs no GitHub credentials or network access to GitHub.

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

`sha256sum --check SHA256SUMS` must report all three Agent binaries as `OK` before deployment. Keep the filenames unchanged because `manifest.json` references them directly.

On macOS, use `shasum -a 256 -c SHA256SUMS`. On native Windows, use WSL for the commands above or compare every binary with its `SHA256SUMS` entry using PowerShell `Get-FileHash -Algorithm SHA256`. Do not deploy from filenames alone.

## 2. Start the Server

```sh
cp compose.v2.example.yml compose.yml
export CODEX_METER_ADMIN_PASSWORD='a-long-unique-random-password'
export CODEX_METER_SERVER_URL='https://meter.example.com'
# Exact backend source IP of the HTTPS reverse proxy. Loopback is trusted by default.
export CODEX_METER_TRUSTED_PROXIES='127.0.0.1,::1'
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/v1/health
```

The Compose service sets `CODEX_METER_RELEASE_DIR=/releases` and mounts `./releases:/releases:ro`. The image runs Node 24.15 as the nonroot `node` user. One process serves the Dashboard, API, installers, and release assets and writes `/data/meter.db`. `restart: unless-stopped` makes it persistent.

Keep port 3000 bound to loopback and terminate HTTPS with a trusted reverse proxy. The proxy must preserve the original `Host`, set exactly `X-Forwarded-Proto: https`, and connect from an exact IP listed in `CODEX_METER_TRUSTED_PROXIES`. Set `CODEX_METER_SERVER_URL` to the public HTTPS origin. Docker bridge/NAT addresses vary, so replace the loopback default with the proxy's backend source IP when the proxy does not connect from loopback; CIDRs and arbitrary forwarded headers are intentionally not trusted.

Enrollment and Agent sync return HTTP `426 https_required` on direct plaintext requests or when the forwarding peer/protocol is not trusted. The health and release endpoints remain available over loopback HTTP for local deployment checks.

There is no Redis, PostgreSQL, or queue. SQLite is a single-service MVP: never scale this service above one replica or mount the database into two writers.

## 3. Verify release serving

Verify every file through the Server endpoint, not only on the host filesystem:

```sh
base='http://127.0.0.1:3000/api/v1/agent/releases'
check_dir="$(mktemp -d)"
for asset in \
  manifest.json \
  SHA256SUMS \
  codex-meter-agent-linux-x64 \
  codex-meter-agent-windows-x64.exe \
  codex-meter-agent-macos-arm64
do
  curl -fSLo "$check_dir/$asset" "$base/$asset"
done
(
  cd "$check_dir"
  sha256sum --check SHA256SUMS
)
rm -rf "$check_dir"
```

Repeat the manifest check through the public HTTPS origin used by Dashboard-generated installers:

```sh
curl -fsS https://meter.example.com/api/v1/agent/releases/manifest.json
```

A successful response plus three `OK` checksum results proves that the manifest and referenced Agent artifacts are available through the same release endpoint used by `install.sh` and `install.ps1`.

## Updating Agent release assets

Download the complete new release into a temporary directory, verify `SHA256SUMS`, then replace the contents of `./releases/` as one deployment operation and restart the service if required by your deployment process. Never mix a new manifest with old binaries. Preserve the read-only container mount.

## Backup and restore

For the simplest consistent backup, stop the service, copy the named volume's `meter.db` (and any `-wal`/`-shm` files if present) as a unit, then restart. Alternatively use SQLite's online backup API/tool against `/data/meter.db`. Test restores. Restore only while the Server is stopped and preserve file ownership for UID 1000.

Review logs with `docker compose logs`; rotate application/container logs at the Docker host. Logs must never contain raw rollout lines or credentials.
