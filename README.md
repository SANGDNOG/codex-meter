# Codex Meter

[![Node.js 22](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Tests](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml/badge.svg)](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Codex Meter is a small, dependency-free quota and usage meter for **exactly three people** who each run and authenticate their own local [OpenAI Codex CLI](https://github.com/openai/codex).

It is **not an OpenAI plugin, OAuth proxy, or official billing tool**. It is a cooperative local wrapper plus a central Node.js server.

> 한국어 요약: 세 사람이 각자 본인의 Codex CLI와 계정을 그대로 사용하면서, 중앙 서버에서 사용량을 같은 한도로 관리하는 도구입니다. 프롬프트·응답·소스 코드·Codex 인증정보는 서버로 보내지 않고 숫자 토큰 카운터 5개만 전송합니다. 자세한 설치 순서는 아래 명령을 그대로 따르면 됩니다.

## What it does

```text
Each user's computer                         Central meter server
┌─────────────────────────────┐              ┌──────────────────────────┐
│ own Codex CLI + own OAuth   │              │ three meter identities   │
│             │               │              │ equal shared policy      │
│ Codex Meter wrapper         │── 5 counters→│ quota + active lease     │
│ reads local token_count only│← allow/stop ─│ usage API + admin view   │
└─────────────────────────────┘              └──────────────────────────┘
```

- Requires **exactly three unique meter users**.
- Applies one configurable quota and reset period equally to all three users.
- Allows one active wrapper per user.
- Denies a new run when the user is disabled, already active, or out of quota.
- Stops a connected run after its measured usage crosses the quota.
- Expires stale leases after a crashed or disconnected client.
- Spools numeric updates during transient network failures and replays them idempotently.
- Gives each user an authenticated own-usage endpoint and gives the administrator aggregate JSON/HTML views.
- Uses only Node.js 22 built-ins; **no `npm install` is required**.

## Privacy boundary

Codex Meter locally streams Codex session JSONL line by line only to find `token_count` records. It discards every other record and never retains or transmits prompts, responses, tool calls, source content, or other session content.

The only usage values accepted by the server are these five nonnegative safe-integer counters:

- `input_tokens`
- `cached_input_tokens`
- `output_tokens`
- `reasoning_output_tokens`
- `total_tokens`

Codex Meter does **not** read, copy, proxy, distribute, or store Codex OAuth credentials or `auth.json`. Each person installs and authenticates Codex locally. Separate random meter tokens authorize only this meter, and the server stores their SHA-256 hashes rather than plaintext tokens.

## Requirements

### Server

- Linux, macOS, or Windows with Node.js 22+
- A trusted HTTPS reverse proxy, VPN, or SSH tunnel if clients connect remotely

### Each client

- Node.js 22+
- Official Codex CLI installed and authenticated locally
- A distinct meter token issued by the server administrator

## Quick start: server

Clone the repository on the server:

```sh
git clone https://github.com/SANGDNOG/codex-meter.git
cd codex-meter
node --version
npm test
```

Initialize the state once. Exactly three unique user IDs are mandatory:

```sh
export CODEX_METER_STATE="$HOME/.codex-meter-server/state.json"
umask 077
node bin/admin.js init \
  --users=alice,bob,carol \
  --quota=1000000 \
  --reset-ms=2592000000 \
  --max-leases=1 \
  --lease-ttl-ms=120000 \
  > meter-tokens-once.json
```

The example uses a 1,000,000-token quota and a 30-day reset period. Choose values that match your policy.

`meter-tokens-once.json` contains the admin token and three user tokens in plaintext **only once**. Give each person only their own token through a secure channel, then securely remove the file. If you lose the tokens, initialize a new state instead of trying to recover them from the hash-only state file.

Start the server on localhost:

```sh
CODEX_METER_HOST=127.0.0.1 \
CODEX_METER_PORT=8787 \
node bin/server.js
```

Health check:

```sh
curl http://127.0.0.1:8787/health
```

Do not expose this plain HTTP listener directly to an untrusted network. Use HTTPS through a trusted reverse proxy or access it only through a VPN/SSH tunnel. Bearer tokens are credentials and plain HTTP exposes them in transit.

## Client setup

Clone or copy this repository to each user's computer. Never place Codex `auth.json` inside this project.

Each user creates a private `client.json` containing the reachable server URL and only that user's meter token.

### macOS / Linux

```sh
git clone https://github.com/SANGDNOG/codex-meter.git
cd codex-meter
mkdir -p "$HOME/.codex-meter"
chmod 700 "$HOME/.codex-meter"
cat > "$HOME/.codex-meter/client.json" <<'JSON'
{
  "serverUrl": "https://meter.example.internal/",
  "meterToken": "PASTE_ONLY_THIS_USERS_METER_TOKEN",
  "pollIntervalMs": 5000
}
JSON
chmod 600 "$HOME/.codex-meter/client.json"
chmod +x clients/unix/codex-meter
```

Use the wrapper anywhere you would normally use `codex`:

```sh
/path/to/codex-meter/clients/unix/codex-meter
/path/to/codex-meter/clients/unix/codex-meter --model MODEL_NAME "your prompt"
```

Optional shell alias:

```sh
alias codex-meter="/path/to/codex-meter/clients/unix/codex-meter"
```

### Windows 10/11 PowerShell

```powershell
git clone https://github.com/SANGDNOG/codex-meter.git
cd codex-meter
New-Item -ItemType Directory -Force "$HOME\.codex-meter" | Out-Null
@'
{
  "serverUrl": "https://meter.example.internal/",
  "meterToken": "PASTE_ONLY_THIS_USERS_METER_TOKEN",
  "pollIntervalMs": 5000
}
'@ | Set-Content -Encoding utf8 "$HOME\.codex-meter\client.json"
```

Run Codex through the PowerShell wrapper:

```powershell
powershell -NoProfile -File .\clients\windows\codex-meter.ps1
powershell -NoProfile -File .\clients\windows\codex-meter.ps1 --model MODEL_NAME "your prompt"
```

The wrapper forwards arguments as an array and never invokes `cmd.exe`. It prefers a native `codex.exe`; for the standard npm `codex.cmd` shim, it executes the adjacent official `@openai/codex/bin/codex.js` with Node. For a nonstandard installation, set `CODEX_METER_CODEX` to the full native `codex.exe` path, not a `.cmd` file.

## Configuration

### Server environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `CODEX_METER_STATE` | `~/.codex-meter-server/state.json` | Server state file |
| `CODEX_METER_HOST` | `127.0.0.1` | Listen address |
| `CODEX_METER_PORT` | `8787` | Listen port |

### Client settings

| Setting / variable | Default | Purpose |
|---|---:|---|
| `serverUrl` | required | Reachable meter server base URL |
| `meterToken` | required | This user's separate meter credential |
| `pollIntervalMs` | `5000` | Polling interval, from 1000 to 60000 ms |
| `CODEX_METER_HOME` | `~/.codex-meter` | Client config, lock, and spool directory |
| `CODEX_HOME` | `~/.codex` | Local Codex home; sessions are read below `sessions/` |
| `CODEX_METER_CODEX` | auto-detected | Explicit Codex executable path |

## Usage and administration

A user can see only their own usage:

```sh
curl --oauth2-bearer USER_METER_TOKEN \
  https://meter.example.internal/v1/usage
```

The administrator can read aggregate JSON or the small HTML dashboard:

```sh
curl --oauth2-bearer ADMIN_METER_TOKEN \
  https://meter.example.internal/admin.json

curl --oauth2-bearer ADMIN_METER_TOKEN \
  https://meter.example.internal/admin
```

To disable or re-enable a user, stop the server first so there are no competing state writers:

```sh
export CODEX_METER_STATE="$HOME/.codex-meter-server/state.json"
node bin/admin.js set-enabled alice false
node bin/admin.js set-enabled alice true
```

## Exit codes

| Code | Meaning |
|---:|---|
| `0` or Codex code | Normal Codex exit |
| `69` | Meter unavailable at startup |
| `73` | Another local wrapper holds the client lock |
| `74` | Local Codex sessions could not be scanned |
| `75` | Quota/disable stop or permanent HTTP 4xx meter failure |
| `77` | Start denied because of quota, disable, or active lease |
| `78` | Missing or invalid local configuration |
| `127` | Codex executable could not be started |

## Failure behavior

- After a successful start, transient network/server failures **fail open** so local Codex can continue.
- Numeric absolute updates are written to a private local spool and replayed on the next run.
- Duplicate replay does not double-count because updates use absolute per-lease high-water values.
- HTTP 4xx authentication/protocol failures stop the wrapped Codex process.
- Connected quota enforcement may overshoot by roughly one polling interval.
- During an outage, central disable/quota enforcement is unavailable and overshoot can be unbounded until connectivity and replay return.

## Limitations

- This is **cooperative metering**. A user can bypass it by launching `codex` directly or altering local software.
- It is not official OpenAI/Codex quota or billing accounting and may differ from provider totals.
- One meter user may run only one wrapper at a time; overlapping scans could double-count one user's session directory.
- Local session deletion/truncation, abrupt power loss, filesystem failure, multiple independent client homes, or future Codex session-format changes can reduce accuracy.
- `SIGKILL` or sudden power loss can happen before the final local scan. Stale leases prevent permanent lockout but cannot recover events that were never observed.

## Tests

```sh
npm test
```

The deterministic `node:test` suite covers local parser filtering, strict request schemas, delta calculation, idempotent updates/replay, authentication failures, exhausted starts, quota crossing, stale leases, hash-only token storage, local locking, literal shell-free arguments, and the real wrapper/server stop path with a fake Codex process.

## Project layout

```text
bin/                  server, admin CLI, and Codex wrapper entry points
clients/unix/         macOS/Linux launcher
clients/windows/      PowerShell launcher
lib/                  server, store, client, command, and usage modules
test/                 deterministic Node.js tests and fixtures
```

## License and disclaimer

MIT License. See [LICENSE](LICENSE).

This is an independent community project and is not affiliated with, endorsed by, or supported by OpenAI. “OpenAI” and “Codex” are trademarks of their respective owners.
