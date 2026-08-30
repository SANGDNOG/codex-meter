# V2 Server deployment

```sh
cp compose.v2.example.yml compose.yml
export CODEX_METER_ADMIN_PASSWORD='a-long-unique-random-password'
export CODEX_METER_SERVER_URL='https://meter.example.com'
# Exact backend source IP of the HTTPS reverse proxy. Loopback is trusted by default.
export CODEX_METER_TRUSTED_PROXIES='127.0.0.1,::1'
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/api/v1/health
```

The image runs Node 24.15 as the nonroot `node` user. One process serves the Dashboard and API and writes `/data/meter.db`. `restart: unless-stopped` makes it persistent. Keep port 3000 bound to loopback and terminate HTTPS with a trusted reverse proxy. The proxy must preserve the original `Host`, set exactly `X-Forwarded-Proto: https`, and connect from an exact IP listed in `CODEX_METER_TRUSTED_PROXIES`. Set `CODEX_METER_SERVER_URL` to the public HTTPS origin. Docker bridge/NAT addresses vary, so replace the loopback default with the proxy's backend source IP when the proxy does not connect from loopback; CIDRs and arbitrary forwarded headers are intentionally not trusted.

Enrollment and Agent sync return HTTP `426 https_required` on direct plaintext requests or when the forwarding peer/protocol is not trusted. The health endpoint remains available over loopback HTTP for container health checks.

There is no Redis, PostgreSQL, or queue. SQLite is a single-service MVP: never scale this service above one replica or mount the database into two writers.

## Backup and restore

For the simplest consistent backup, stop the service, copy the named volume's `meter.db` (and any `-wal`/`-shm` files if present) as a unit, then restart. Alternatively use SQLite's online backup API/tool against `/data/meter.db`. Test restores. Restore only while the Server is stopped and preserve file ownership for UID 1000.

Review logs with `docker compose logs`; rotate application/container logs at the Docker host. Logs must never contain raw rollout lines or credentials.