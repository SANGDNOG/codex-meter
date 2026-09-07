# CANARY DEPLOY RUNBOOK — V2.2 OpenCodex Hub

> Repository-safe template. Machine-specific usernames, SSH paths, addresses and
> hostnames below are **redacted examples**, not executable production coordinates.
> The exact previously inspected operator copy is retained privately outside Git.
> Before manual deployment, use that copy or substitute independently verified
> local values throughout (including unit, proxy IP, DNS/hosts and rollback).
> Do not deploy literal `*.example` domains or example addresses. Validation and
> topology observations below describe the original preparation snapshot.

Preparation only, inspected 2026-09-07. No deployment, checkpoint commit, push,
secret generation, service start, DNS change or Caddy reload has been performed.

## Current State

- Repository: `/home/developer/codex-meter`, branch `feature/v2.2-opencodex-hub`.
- Actual remote main (`git ls-remote`, not merely a cached ref):
  `654729dadd8d1c4d0b3841fadcd25e8c9da50878`.
- HEAD/main/origin-main remain that SHA. The remote feature branch is absent.
- Implementation is **uncommitted**: 11 tracked modified files plus 8 new files
  before this runbook. `git diff --stat` alone does not include the new modules,
  migrations and tests. Nothing is staged. This runbook is an additional file.
- Fresh preparation run: `npm test` **378/378**, failures/skips/cancellations 0.
  Log: `/tmp/codex-meter-v22-runbook-tests.log`.
- Fresh `npm run check:syntax`: 80 JavaScript files PASS; installer `sh -n` PASS.
- Runbook shell blocks passed `bash -n` without execution. Working/staged diff
  whitespace checks passed. A heuristic credential-pattern scan of all 20
  changed/new files flagged 0 files; this is not a substitute for staged review.
- Alias-check logic passed 6/6 synthetic endpoint/collision cases without
  executing Docker commands. All 15 final shell blocks passed syntax checks.
- Independent runbook review: gpt-5.6-luna / xhigh, final C0/H0/M0/L0 after
  correcting resolution/alias gates and confirming actual executable paths.
- Previous unchanged implementation validation: V1 68/68, V2 310/310,
  Node 24.15 V2 310/310, Hub focused 56/56, combined focused 109/109,
  syntax 80 files, audit 0. See `v2-opencodex-validation.md`.
- A checkpoint is appropriate after reviewing the complete intended file set.
  Proposed message: **`feat: add OpenCodex Hub snapshots and streamline existing-home onboarding`**.
  Do not stage/commit/push until the owner approves. An archive of current HEAD
  NOW would omit the entire V2.2 implementation; never deploy that as V2.2.

Verified production topology, read-only:

| Item | Actual value |
| --- | --- |
| Machine / SSH user | CANARY_HOST, `deploy@100.64.0.10`, UID/GID 1000 |
| Production server | Docker container `codex_meter` |
| Production image | `local/codex-meter:production-v213` |
| Production working directory / user | container `/app`, `node` |
| Production Compose files | `/home/deploy/services/codex-meter/docker-compose.yml` and `docker-compose.override.yml` |
| Production DB volume | `codex-meter_codex-meter-data`, mounted `/data`; DB `/data/meter.db` |
| Production networking | `cloudflared_default`, container port 3000, no published host port |
| Production ingress | `cloudflared_tunnel`; trusted proxy `172.19.0.2` |
| Production releases mount | `/home/deploy/apps/meter-production/releases` → `/releases`, read-only |
| Server systemd unit | **None**; do not invent `codex-meter.service` |
| Existing Agent unit | user `codex-meter-agent.service`, enabled; leave it alone |
| Host Node | `/usr/bin/node`, **18.19.1**, not suitable for V2 server |
| Host executables | `command -v` rechecked: `/usr/bin/docker`, `/usr/bin/systemctl`, `/usr/bin/node` |
| Container Node | **24.15.0** |
| Caddy | container `opencodex-caddy-1`, Caddy 2.11.4 + Cloudflare module |
| Caddy source | `/home/deploy/services/opencodex/Caddyfile` |
| Caddy networking | `opencodex_default`, observed IP `172.18.0.3`; host listener `100.64.0.10:443` |
| Existing Caddy site | `hub.example` → `hub:10100`; no Meter production or Canary block |
| Caddy TLS | existing Cloudflare DNS integration, runtime environment reference; value not read/output |
| OpenCodex Hub host listener | `127.0.0.1:10100` (port metadata only; no account API accessed) |

Production public health returned HTTP 200, `status=ok`. Port 43023, the proposed
Canary root/container/unit names were unused at inspection time. Canary DNS did
not resolve through this machine's resolver; do not assume public routing exists.

## Canary Isolation

The following are **new proposed names**, not claimed existing deployment paths.
Use CANARY_HOST so the current Docker/Node image architecture can be reused.

| Resource | Canary only |
| --- | --- |
| Root | `/home/deploy/apps/codex-meter-v22-canary` |
| Source / working directory | root `/source`; container `/app` |
| Container | `codex-meter-canary-v22` |
| Image | `local/codex-meter:v22-canary-<APPROVED_CHECKPOINT_SHA>` |
| DB | root `/server-data/meter.db`; only this directory mounted `/data` |
| Server config | root `/server.env`, owner-only |
| Unit | `/home/deploy/.config/systemd/user/codex-meter-canary.service` |
| Host port | **127.0.0.1:43023** → container 3000 |
| Docker route | new container joins existing `opencodex_default`, alias `codex-meter-canary-v22` |
| Public/base URL | `https://canary.meter.example` |
| Server logs | separate user journal identifier/unit `codex-meter-canary` |
| Agent binary | root `/bin/codex-meter-agent-canary` |
| Agent config/state | root `/agent-state/agent.json`, newly enrolled `agent-<device-id>.db` |
| Hub credential file | root `/agent-state/hub-credential`, supplied privately by operator |
| Agent connection | root `/agent-state/hub-connection.json`, Agent-created |
| Agent logs | root `/logs/agent.log`, owner-only; never redirect interactive picker/secret input here |

Do not mount/copy the production DB, `.env`, releases, user Agent state or any
actual CODEX_HOME. Do not use production `compose up/down`, production Agent
update/install commands, or a directory named merely `data` without an absolute
scope. Container removal must never remove bind-mounted Canary data.

## Exact Server Command

Source of truth: `package.json`, `bin/v2-server.js`, `Dockerfile.v2`.

```sh
node bin/v2-server.js
# Equivalent package script:
npm run v2-server
```

`npm run server` starts the legacy server and is WRONG here. Node >=24.15 is
enforced by the real entry point. The unit below uses a freshly built candidate
image based on the repository's `node:24.15.0-bookworm-slim`; do not upgrade the
host Node or borrow the production container to run candidate code.

## Required Environment

Save this proposed content to Canary `server.env` only, after deployment approval.
The admin value is a placeholder, not a generated secret. Supply it privately;
never print `server.env`, run `set -x`, or dump full Docker inspection output.

```dotenv
NODE_ENV=production
CODEX_METER_HOST=0.0.0.0
CODEX_METER_PORT=3000
CODEX_METER_DB=/data/meter.db
CODEX_METER_SERVER_URL=https://canary.meter.example
CODEX_METER_TRUSTED_PROXIES=172.18.0.3
CODEX_METER_QUOTA_STALE_SECONDS=300
CODEX_METER_ADMIN_PASSWORD=<CANARY_ONLY_ADMIN_PASSWORD>
```

- `HOST=0.0.0.0` is **inside the container**. Only host loopback 43023 is published.
- `TRUSTED_PROXIES` accepts exact IPs, not CIDRs/hostnames. Recheck the Caddy
  address before starting; update only the Canary env if it changed. Do not
  trust production tunnel IP `172.19.0.2` for this direct Caddy route.
- `CODEX_METER_DB` defaults to `./data/meter.db`; always override it as above.
- Admin password is required on a new DB and initializes its own salted hash.
  Changing the env later does not reset an existing DB's admin password.
- There is **no SESSION_SECRET/JWT_SECRET env**. Session tokens/CSRF are generated
  by the server during login and stored in its separate DB. Cookie is host-only;
  default session lifetime is 12 hours, enrollment lifetime 15 minutes. These
  constructor options are not configurable via invented entry-point env vars.
- `CODEX_METER_RELEASE_DIR` is optional and deliberately **unset**. Do not mount
  production release artifacts: its installer could supply stock V2.1.3, not
  this candidate. Use the separately built candidate Agent described below.
- Default quota stale threshold is 300 seconds. The Hub view currently has its
  own fixed five-minute stale threshold; this env is not a Hub polling knob.
- Migrations run **automatically at startup** against `CODEX_METER_DB`: WAL,
  foreign keys, 5s busy timeout, owner-only DB/WAL permissions, contiguous
  migrations 001–010 with checksum verification. Each migration is transactional.
  Startup can create/migrate the DB even before a later config/login error, so
  DB isolation must be verified BEFORE the first process starts.
- No other env is required for the Server. Hub credential/URL belong only to
  the Agent, never this env file.

## Files / Paths

No files from this section have been installed on CANARY_HOST. Before an approved
deploy, place a frozen checkpoint archive and compiled Agent in the new root.
Retain SHA-256 sums and the full checkpoint SHA as evidence. Never deploy a dirty
copy while calling it a checkpoint, and never run `git archive HEAD` before the
approved checkpoint actually exists.

Candidate source archive includes `Dockerfile.v2`, `package.json`, `package-lock.json`,
`bin/`, `lib/`, `v2/`, tests and docs. Runtime image only uses files copied by
`Dockerfile.v2`. The Agent packaging script embeds migrations and bundles its
dependencies; it requires Node >=24.15 and Linux x64 for a Linux x64 artifact.

## systemd Unit Draft

This is a **new user unit** for verified user `deploy`, not a replacement for
a production system unit. Do not add `User=`/`Group=` to a user unit. Its child
container uses UID/GID 1000:1000, matching the inspected user and image's node user.
User lingering is already enabled; do not change it.

Replace the checkpoint placeholder before installing this draft:

```ini
[Unit]
Description=Codex Meter V2.2 Canary Server (isolated Docker process)
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=exec
WorkingDirectory=/home/deploy/apps/codex-meter-v22-canary/source
Environment=CANARY_IMAGE=local/codex-meter:v22-canary-<APPROVED_CHECKPOINT_SHA>
UMask=0077
ExecStart=/usr/bin/docker run --rm --init --name codex-meter-canary-v22 --label codex-meter.scope=v22-canary --user 1000:1000 --network opencodex_default --network-alias codex-meter-canary-v22 --publish 127.0.0.1:43023:3000 --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,noexec,size=16m --env-file /home/deploy/apps/codex-meter-v22-canary/server.env --mount type=bind,src=/home/deploy/apps/codex-meter-v22-canary/server-data,dst=/data ${CANARY_IMAGE}
ExecStop=/usr/bin/docker stop --time 30 codex-meter-canary-v22
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillMode=process
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codex-meter-canary

[Install]
WantedBy=default.target
```

`CANARY_IMAGE` is a unit-local wrapper variable, not an application setting.
`--rm` removes only this ephemeral container when it exits; source, DB, env and
host logs remain. Do not issue `docker rm` against a pre-existing name collision;
stop and investigate instead. Docker must already be running. No enablement is
needed for a manual Canary.

## Caddy Draft

**Important topology correction:** host `127.0.0.1:43023` is for host health checks.
Inside `opencodex-caddy-1`, localhost points to Caddy itself. A literal
`reverse_proxy 127.0.0.1:43023` would NOT reach the proposed server. Reuse the
inspected Docker network, with this draft block instead:

```caddyfile
# BEGIN CODEX-METER-V22-CANARY — new site only
canary.meter.example {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy codex-meter-canary-v22:3000
}
# END CODEX-METER-V22-CANARY
```

The credential expression is the existing Caddy runtime reference, not a token
value. Reusing this shared ingress credential/issuer for a new hostname requires
explicit operator approval; Meter admin/Agent secrets remain separate. A separate
Canary DNS credential would require an additional ingress configuration decision,
not silently adding an env variable to the existing Caddy container.

Do not edit a `meter.example` block: **no such block exists here**.
Production Meter's Cloudflare Tunnel and Compose files must remain byte-for-byte
unchanged. Append only the clearly delimited new block to a separately prepared
copy; review the diff before any approved activation. Current Caddyfile has no
`import` hook, so merely dropping a snippet file somewhere will not load it.

The current listener is Tailscale-only `100.64.0.10:443`. It does not make the
new hostname publicly reachable from the Internet. For first manual validation,
an authorized Tailscale client may use `curl --resolve` (below), with no DNS change.
Browser/Agent name resolution needs an approved client hosts/DNS mapping. Public
Internet ingress is a separate routing decision; do not assume this listener is
a public IP, edit DNS, or alter the production tunnel to achieve it.

Only if a future Caddy actually runs in the HOST network would this alternate
backend line be correct: `reverse_proxy 127.0.0.1:43023`. It is NOT today's plan.

Syntax reference: [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Caddy import](https://caddyserver.com/docs/caddyfile/directives/import).

## Preflight

All commands in this section are **read-only**, except optional tests which write
only temporary fixture DBs on the development machine. No service starts/reloads.

Development machine:

```sh
cd /home/developer/codex-meter
git branch --show-current
git status --short
git ls-remote origin refs/heads/main refs/heads/feature/v2.2-opencodex-hub
git diff --stat origin/main
git ls-files --others --exclude-standard
git diff --check
git diff --cached --check
npm test
```

Server-41, log in as the verified deployment user:

```sh
ssh -i /home/developer/.ssh/canary_deploy_key \
  -o BatchMode=yes -o ConnectTimeout=10 deploy@100.64.0.10
id
docker inspect --format '{{.Config.Image}} {{.State.Status}} {{.State.Health.Status}}' codex_meter
docker exec codex_meter node --version
curl --fail --silent --show-error --max-time 15 https://meter.example/api/v1/health
ss -ltn '( sport = :43023 )'
docker ps -a --filter 'name=^/codex-meter-canary-v22$' --format '{{.Names}}'
systemctl --user list-unit-files --no-pager codex-meter-canary.service
docker network inspect opencodex_default --format '{{json .IPAM.Config}}'
docker inspect --format '{{(index .NetworkSettings.Networks "opencodex_default").IPAddress}}' opencodex-caddy-1
test ! -e /home/deploy/apps/codex-meter-v22-canary
test ! -e /home/deploy/.config/systemd/user/codex-meter-canary.service
```

In the same CANARY_HOST shell, define and run this read-only alias check. It uses
the existing host Node 18 for JSON inspection only, NOT to run Meter:

```sh
canary_alias_check() {
  node --input-type=module - "$1" <<'NODE'
import { execFileSync } from 'node:child_process';
const inspect = (...args) => JSON.parse(execFileSync('/usr/bin/docker', args, {encoding:'utf8'}));
const network = 'opencodex_default', alias = 'codex-meter-canary-v22';
const endpoints = inspect('network', 'inspect', network)[0].Containers ?? {};
const metadata = '{"Name":{{json .Name}},"Aliases":{{json (index .NetworkSettings.Networks "opencodex_default").Aliases}}}';
const matches = Object.keys(endpoints).map(id => inspect('inspect', '--format', metadata, id))
  .filter(c => c.Name === '/' + alias || (c.Aliases ?? []).includes(alias));
const valid = process.argv[2] === 'absent' ? matches.length === 0 :
  process.argv[2] === 'present' && matches.length === 1 && matches[0].Name === '/' + alias;
if (!valid) { console.error('STOP: Canary network alias collision or missing endpoint'); process.exit(1); }
console.log('Canary network alias check passed');
NODE
}
canary_alias_check absent
```

Expect empty listener/container/unit collision checks, Caddy IP matching the
planned Canary env value, and no proposed root on FIRST installation. A failed check is a stop
condition, not permission to delete/overwrite existing data. For repeat runs,
inspect the explicitly identified Canary artifacts instead of reusing first-run
commands blindly. A health response is liveness, not a complete DB integrity test.

## Deployment Commands

**NOT EXECUTED. All write/start commands below require the owner's later approval.**
Do not copy this entire section into a shell as one script. Perform each gate.

1. **Approve checkpoint — development repo only, no production impact.** Review
   the 19 implementation/doc files listed in `v2-opencodex-validation.md`, plus
   this runbook. Include the runbook in the approved checkpoint so the clean-tree
   freeze check below is satisfied. Stage only the reviewed filenames (not `git add .`),
   inspect staged diff/checks/privacy, then use the proposed commit message.
   No push is required for an archive-based Canary. Record the resulting full
   SHA. The old baseline SHA is NOT a V2.2 checkpoint.

2. **Build frozen artifacts — development machine only.** After that approval:

```sh
cd /home/developer/codex-meter
test -z "$(git status --porcelain)"
CANARY_CHECKPOINT=$(git rev-parse HEAD)
test "$CANARY_CHECKPOINT" != 654729dadd8d1c4d0b3841fadcd25e8c9da50878
CANARY_STAGE=$(mktemp -d /tmp/codex-meter-v22-freeze.XXXXXX)
git archive --format=tar --output="$CANARY_STAGE/source.tar" "$CANARY_CHECKPOINT"
CODEX_METER_RELEASE_TARGET=linux-x64 CODEX_METER_RELEASE_OUT="$CANARY_STAGE/agent" \
  npx --yes --package=node@24.15.0 -c 'npm run package:v2-agent'
sha256sum "$CANARY_STAGE/source.tar" "$CANARY_STAGE/agent/codex-meter-agent-linux-x64"
```

The script's `RELEASE_*` names select a local build target/output; this does not
create a tag/GitHub release or replace published artifacts. Preserve the full SHA
and sums in operator evidence. The candidate still reports Agent version 2.1.3;
use checkpoint/artifact checksums to establish identity, not that version string.

3. **Prepare the NEW root — CANARY_HOST Canary files only.** After preflight succeeds:

```sh
umask 077
mkdir /home/deploy/apps/codex-meter-v22-canary
mkdir /home/deploy/apps/codex-meter-v22-canary/source
mkdir /home/deploy/apps/codex-meter-v22-canary/server-data
mkdir /home/deploy/apps/codex-meter-v22-canary/agent-state
mkdir /home/deploy/apps/codex-meter-v22-canary/bin
mkdir /home/deploy/apps/codex-meter-v22-canary/logs
```

From development, copy the two generated artifacts into this NEW root via the
verified SSH identity, then verify their recorded SHA-256 on CANARY_HOST. Do not
use a production directory as the destination. No secrets are in this transfer.

```sh
scp -i /home/developer/.ssh/canary_deploy_key \
  "$CANARY_STAGE/source.tar" \
  deploy@100.64.0.10:/home/deploy/apps/codex-meter-v22-canary/source.tar
scp -i /home/developer/.ssh/canary_deploy_key \
  "$CANARY_STAGE/agent/codex-meter-agent-linux-x64" \
  deploy@100.64.0.10:/home/deploy/apps/codex-meter-v22-canary/bin/codex-meter-agent-canary
```

Server-41; replace the SHA placeholder with the approved full SHA:

```sh
CANARY_CHECKPOINT='<APPROVED_CHECKPOINT_SHA>'
test "${#CANARY_CHECKPOINT}" -eq 40
cd /home/deploy/apps/codex-meter-v22-canary
sha256sum source.tar bin/codex-meter-agent-canary
tar -tf source.tar
# Only continue after confirming the recorded sums and archive member paths.
tar -xf source.tar -C source
chmod 700 bin/codex-meter-agent-canary
docker build --label "codex-meter.candidate=$CANARY_CHECKPOINT" \
  -f source/Dockerfile.v2 \
  -t "local/codex-meter:v22-canary-$CANARY_CHECKPOINT" source
```

This creates a NEW image only. It must not retag or restart production. Privately
create `server.env` with the proposed values and a distinct real admin password,
mode 0600. Stop if the placeholder is still present. Do not show its contents.
Save the unit draft, replacing its SHA, at the new user-unit path with mode 0644.
The verified user already has a user systemd directory. No real secret is
generated or displayed by any command in this preparation runbook.

Immediately before starting, repeat the Caddy IP inspection from Preflight and
privately confirm it equals `CODEX_METER_TRUSTED_PROXIES` in the newly written
Canary env. Do not print that env file. Repeat `canary_alias_check absent` too;
any mismatch/collision is a stop condition.

4. **Start backend — Canary process/DB only, explicitly approved later.**

```sh
systemctl --user daemon-reload
systemctl --user start codex-meter-canary.service
systemctl --user status codex-meter-canary.service --no-pager
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:43023/api/v1/health
```

`daemon-reload` reloads unit definitions but does not restart existing services.
`start` starts ONLY the named Canary unit and migrates ONLY its mounted DB.
Do not enable it at boot. Verify mounts/image/health below before any ingress work.
In the same CANARY_HOST shell, `canary_alias_check present` must now pass, proving
exactly one endpoint owns the proposed alias and it is the Canary container.
Repeat that check immediately before Caddy activation. If reconnecting by SSH,
redefine the function above before using it; do not skip this gate.

5. **Ingress — separate SHARED-CADDY APPROVAL gate.** Prepare a copy of the
   existing Caddyfile, append only the marked block, and review the exact diff.
   Do not replace existing global/OpenCodex blocks or the Compose file. The
   existing file is individually bind-mounted: activation must ensure the
   container sees the intended new bytes (an atomic host rename can leave an
   old bind-mounted inode). Verify host/container checksums before reload.
   Have the ingress operator validate the complete candidate with the installed
   Cloudflare module, then explicitly approve a reload. There are intentionally
   **no automatically executable edit/reload/DNS commands** here: this is shared
   OpenCodex ingress, not a Canary-only operation. Production Meter tunnel is
   untouched. If shared ingress changes are not approved, stop at loopback health.

6. **Mandatory hostname-resolution gate — before creating/enrolling a Device.**
   An ingress administrator must first provide an approved mapping on BOTH
   CANARY_HOST and the operator's browser client. For this Tailscale-only plan,
   the exact hosts entry, if that mechanism is approved, is:

```text
100.64.0.10 canary.meter.example # codex-meter-v22-canary
```

   Hosts/DNS editing is an administrator action, not performed by this runbook's
   preparation. Never replace the whole hosts file or modify production entries.
   Record the chosen mechanism and its owner. Stop if it is not provided.
   On CANARY_HOST, all of these read-only checks MUST pass using normal resolution:

```sh
getent ahostsv4 canary.meter.example
getent ahostsv4 canary.meter.example | awk '
  $1 != "100.64.0.10" { bad=1 }
  { seen=1 }
  END { exit (!seen || bad) }
'
curl --fail --silent --show-error --max-time 15 \
  https://canary.meter.example/api/v1/health
```

   Also verify the normal HTTPS page in the browser client. `curl --resolve`
   alone never satisfies this gate. A different approved public ingress design
   needs its own address checks; do not silently bypass the Tailscale assertion.

7. **Canary Agent — separate binary/config, not the existing installed service.**
   Only after the mandatory resolution gate passes, create exactly one
   OpenCodex Hub Account Profile and a NEW Device enrollment on the CANARY site.
   Do not execute its stock installer command. Use the candidate binary:

```sh
/home/deploy/apps/codex-meter-v22-canary/bin/codex-meter-agent-canary enroll \
  --server https://canary.meter.example \
  --token '<FRESH_CANARY_ONE_TIME_ENROLLMENT_TOKEN>' \
  --config /home/deploy/apps/codex-meter-v22-canary/agent-state/agent.json \
  --codex-home /home/deploy/apps/codex-meter-v22-canary/agent-state/unused-native-home
```

This CLI actually accepts `--token` via argv; do not claim it supports stdin for
enrollment. Supply privately in a non-recorded operator session; never paste the
real token in the runbook/report. The explicit dummy Home is Canary-owned, not a
user's Home; Hub-only configuration must produce no native collectors. The CLI
does not expose `--database-path`: enrollment creates its separate Device DB
alongside this explicit config. There is no manual JSON editing.

Place an operator-provided Hub management credential in the NEW 0600 file
`agent-state/hub-credential`; do not scrape OpenCodex config/auth or reuse Meter's
production Agent secret. The local Hub port below is verified, but account API
compatibility/authentication remains a real Canary test, not assumed success.

```sh
/home/deploy/apps/codex-meter-v22-canary/bin/codex-meter-agent-canary opencodex connect \
  --url http://127.0.0.1:10100 \
  --secret-file /home/deploy/apps/codex-meter-v22-canary/agent-state/hub-credential \
  --config /home/deploy/apps/codex-meter-v22-canary/agent-state/agent.json
/home/deploy/apps/codex-meter-v22-canary/bin/codex-meter-agent-canary profile attach-opencodex \
  --config /home/deploy/apps/codex-meter-v22-canary/agent-state/agent.json
/home/deploy/apps/codex-meter-v22-canary/bin/codex-meter-agent-canary run \
  --config /home/deploy/apps/codex-meter-v22-canary/agent-state/agent.json
```

Use a dedicated foreground terminal for the last command; Ctrl-C stops only this
Canary Agent. No existing Agent restart/service installation. The picker is local
and interactive; select exactly one account and do not log its alias/email.
Hub GET calls may refresh its own caches; this is a later approved integration
effect, not a promise that upstream APIs have no side effects. Native homes are
not involved.

## Verification

After approved backend start, on CANARY_HOST (**read-only checks**):

```sh
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:43023/api/v1/health
docker inspect --format '{{.Config.Image}} {{.State.Health.Status}}' codex-meter-canary-v22
docker inspect --format '{{index .Config.Labels "codex-meter.candidate"}}' codex-meter-canary-v22
docker inspect --format '{{json .Mounts}}' codex-meter-canary-v22
docker inspect --format '{{json .HostConfig.PortBindings}}' codex-meter-canary-v22
journalctl --user -u codex-meter-canary.service -n 40 --no-pager
docker exec codex-meter-canary-v22 node --input-type=module -e \
  "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync('/data/meter.db',{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').all());console.log(d.prepare('PRAGMA foreign_key_check').all());console.log(d.prepare('SELECT max(version) version FROM schema_migrations').get());d.close();"
curl --fail --silent --show-error --max-time 15 https://meter.example/api/v1/health
```

Expect one Canary data bind only (never production volume), host loopback 43023,
integrity `ok`, empty FK errors, migration version 10. Inspect the image's
`codex-meter.candidate` label against the approved SHA; health does not report a
release version or prove candidate identity.

After separately approved Caddy activation, from an authorized Tailscale client
(read-only, no DNS edit, no TLS bypass):

```sh
curl --fail --silent --show-error --max-time 15 \
  --resolve canary.meter.example:443:100.64.0.10 \
  https://canary.meter.example/api/v1/health
```

Do not use `-k` to hide certificate problems. A browser/Agent still needs normal
name resolution; `curl --resolve` does not configure it for other processes.
Verify normal HTTPS health after that independent mapping is approved/provided.

Functional Canary acceptance, on the Canary site only:

- Login uses distinct Canary admin; production session/DB is unaffected.
- Create/select one Hub Profile; Account source says OpenCodex Hub.
- Compare today/7d/30d/all, coverage and quota to selected account in Hub UI.
- Make known requests through the user-selected Hub account, then recompare.
- No fabricated Native events or end-user Device/Group attribution.
- Selected label remains Agent-local; no other accounts, labels, emails/IDs,
  Hub URL or credentials appear in Meter Server reports/storage.
- Restart only the foreground Canary Agent; mapping and snapshot behavior persist.
- Stop/re-add only the Canary binding; keep old snapshots without summing
  overlapping all-time totals. Re-select explicitly.
- Keep raw API responses, local account labels and credentials out of reports.
- Recheck production health and unchanged production image/mount/config hashes.

## Rollback

Rollback is **Canary-only**, and these actions are not executed now.

1. Ctrl-C in the dedicated Canary Agent terminal. Do not stop
   `codex-meter-agent.service` and do not use `pkill`/broad process matching.
2. Stop only the new backend unit:

```sh
systemctl --user stop codex-meter-canary.service
systemctl --user is-active codex-meter-canary.service
ss -ltn '( sport = :43023 )'
```

Expect inactive (nonzero exit is normal) and no listener. If stopping fails,
inspect the exact Canary unit/container; do not remove any production container.
The ephemeral Canary container disappears, but its bind-mounted DB is preserved.

3. If the ingress block was ever activated, the ingress operator removes ONLY
   the marked Canary block and validates/reloads under the separate shared-Caddy
   approval gate. Do not overwrite the full Caddyfile from an old backup: that
   could erase unrelated changes. If no block was activated, do nothing.
4. Keep the stopped unit, image, source, artifacts, DB/WAL, config and logs for
   investigation, owner-only. No `rm -rf`, `docker compose down -v`, database
   downgrade or production restore is needed. Secure archival/deletion requires
   explicit later approval of exact Canary targets. Do not reopen a version-10
   DB with an older app as a shortcut.
5. If the proposed hosts entry was added, its administrator removes exactly the
   `100.64.0.10 canary.meter.example # codex-meter-v22-canary`
   line from CANARY_HOST and each participating client, preserving every other
   entry. If DNS was chosen instead, its owner removes only the recorded Canary
   record. Recheck `getent ahostsv4 canary.meter.example` against the
   pre-Canary state. Do not change production DNS/tunnel routes.
6. Verify production health/image are unchanged. Production data was never
   mounted or migrated, so it requires **no rollback**.

READY FOR MANUAL CANARY DEPLOY
