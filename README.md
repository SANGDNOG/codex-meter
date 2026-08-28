# Codex Meter

[![Node.js 22](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Tests](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml/badge.svg)](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Codex Meter is a small, dependency-free quota and usage meter for **exactly three people** who each run and authenticate their own local [OpenAI Codex CLI](https://github.com/openai/codex).

It is **not an OpenAI plugin, OAuth proxy, or official billing tool**. It is a cooperative local wrapper plus a central Node.js server.

> 한국어 요약: 세 사람이 각자 본인의 Codex CLI와 계정을 그대로 사용하면서, 중앙 서버에서 사용량을 같은 한도로 관리하는 도구입니다. 프롬프트·응답·소스 코드·Codex 인증정보는 서버로 보내지 않고 숫자 토큰 카운터 5개만 전송합니다.

## 한국어 안내

### 어떤 도구인가요?

Codex Meter는 **세 명이 각자 개인 컴퓨터의 터미널에서 Codex CLI를 실행하되, 사용량은 중앙에서 사용자별로 집계하고 같은 쿼터를 적용**하기 위한 도구입니다.

실제 구성은 다음 두 부분으로 나뉩니다.

1. **개인 컴퓨터의 래퍼**가 Codex CLI를 대신 실행합니다.
2. **중앙 Meter 서버**가 세 사용자의 사용량, 쿼터, 실행 상태를 관리합니다.

```text
사용자 A/B/C의 개인 터미널
  └─ Codex Meter 래퍼
       ├─ 중앙 서버에 실행 허가 요청
       ├─ 본인 컴퓨터의 Codex CLI 실행
       ├─ 로컬 세션에서 token_count만 집계
       └─ 숫자 사용량 5개만 중앙 서버에 보고

중앙 Meter 서버
  ├─ 사용자별 누적 사용량
  ├─ 세 명에게 동일한 쿼터 적용
  ├─ 사용자당 동시 실행 1개 제한
  ├─ 쿼터 초과·비활성 사용자 차단
  └─ 사용자용 조회 API와 관리자 대시보드
```

이 프로젝트는 **OpenAI 공식 플러그인이나 공식 사용량·과금 도구가 아닙니다.** Codex 앞에서 실행되는 협력형 로컬 래퍼와 별도의 중앙 관리 서버입니다.

### 개인정보와 인증정보

각 사용자는 자신의 컴퓨터에 Codex CLI를 설치하고 직접 인증합니다. Codex Meter는 다음 정보를 읽거나 서버로 보내지 않습니다.

- Codex OAuth 토큰과 `auth.json`
- 프롬프트와 응답
- 도구 실행 내용
- 소스 코드와 파일 내용
- 일반 세션 이벤트

래퍼는 로컬 Codex 세션 JSONL을 한 줄씩 읽어 `token_count` 이벤트만 찾은 뒤 다음 숫자 5개만 전송합니다.

- `input_tokens`
- `cached_input_tokens`
- `output_tokens`
- `reasoning_output_tokens`
- `total_tokens`

Meter 서버용 사용자 토큰은 Codex 인증정보와 완전히 별개입니다. 서버 상태에는 평문 토큰 대신 SHA-256 해시만 저장됩니다.

### 필요한 환경

- 중앙 서버와 각 사용자 컴퓨터에 **Node.js 22 이상**
- 각 사용자 컴퓨터에 공식 Codex CLI 설치 및 로컬 인증
- 원격 연결 시 HTTPS 리버스 프록시, VPN 또는 SSH 터널
- 정확히 세 개의 고유한 Meter 사용자 ID

외부 런타임 패키지가 없으므로 `npm install`은 필요하지 않습니다.

### 1. 중앙 서버 설치

```sh
git clone https://github.com/SANGDNOG/codex-meter.git
cd codex-meter
node --version
npm test
```

세 명의 사용자와 공통 쿼터를 최초 한 번 초기화합니다.

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

예시는 사용자당 토큰 1,000,000개와 30일 초기화 주기를 사용합니다.

`meter-tokens-once.json`에는 관리자 토큰 1개와 사용자 토큰 3개가 **최초 한 번만 평문으로 출력**됩니다. 각 사용자에게 본인의 토큰만 안전한 방법으로 전달한 뒤 파일을 안전하게 삭제하세요. 토큰을 잃어버리면 해시에서 복구할 수 없으므로 새 상태를 초기화해야 합니다.

서버를 로컬 주소에서 실행합니다.

```sh
CODEX_METER_HOST=127.0.0.1 \
CODEX_METER_PORT=8787 \
node bin/server.js
```

상태 확인:

```sh
curl http://127.0.0.1:8787/health
```

평문 HTTP 서버를 신뢰할 수 없는 네트워크에 직접 공개하지 마세요. 원격 사용자는 HTTPS, VPN 또는 SSH 터널을 통해 접속해야 합니다.

### 2. macOS·Linux 사용자 설정

각 사용자 컴퓨터에서 저장소를 받고 개인 설정 파일을 만듭니다.

```sh
git clone https://github.com/SANGDNOG/codex-meter.git
cd codex-meter
mkdir -p "$HOME/.codex-meter"
chmod 700 "$HOME/.codex-meter"
cat > "$HOME/.codex-meter/client.json" <<'JSON'
{
  "serverUrl": "https://meter.example.internal/",
  "meterToken": "본인에게_발급된_METER_TOKEN",
  "pollIntervalMs": 5000
}
JSON
chmod 600 "$HOME/.codex-meter/client.json"
chmod +x clients/unix/codex-meter
```

이제 원래 `codex`를 실행하던 자리에 래퍼를 사용합니다.

```sh
/path/to/codex-meter/clients/unix/codex-meter
/path/to/codex-meter/clients/unix/codex-meter --model MODEL_NAME "작업 내용"
```

### 3. Windows PowerShell 사용자 설정

```powershell
git clone https://github.com/SANGDNOG/codex-meter.git
cd codex-meter
New-Item -ItemType Directory -Force "$HOME\.codex-meter" | Out-Null
@'
{
  "serverUrl": "https://meter.example.internal/",
  "meterToken": "본인에게_발급된_METER_TOKEN",
  "pollIntervalMs": 5000
}
'@ | Set-Content -Encoding utf8 "$HOME\.codex-meter\client.json"
```

PowerShell 래퍼로 Codex를 실행합니다.

```powershell
powershell -NoProfile -File .\clients\windows\codex-meter.ps1
powershell -NoProfile -File .\clients\windows\codex-meter.ps1 --model MODEL_NAME "작업 내용"
```

PowerShell 래퍼와 Node.js 래퍼는 인수를 배열로 전달하며 `cmd.exe`를 호출하지 않습니다.

### 4. 사용량 확인과 사용자 관리

사용자는 자신의 Meter 토큰으로 본인 사용량만 조회할 수 있습니다.

```sh
curl --oauth2-bearer USER_METER_TOKEN \
  https://meter.example.internal/v1/usage
```

관리자는 전체 사용량 JSON이나 HTML 대시보드를 조회할 수 있습니다.

```sh
curl --oauth2-bearer ADMIN_METER_TOKEN \
  https://meter.example.internal/admin.json

curl --oauth2-bearer ADMIN_METER_TOKEN \
  https://meter.example.internal/admin
```

사용자를 비활성화하거나 다시 활성화할 때는 경쟁 상태를 피하기 위해 먼저 서버를 중지한 뒤 실행합니다.

```sh
export CODEX_METER_STATE="$HOME/.codex-meter-server/state.json"
node bin/admin.js set-enabled alice false
node bin/admin.js set-enabled alice true
```

### 네트워크 장애와 제한 사항

- 실행 전 중앙 서버에 연결할 수 없으면 Codex 실행을 시작하지 않습니다.
- 정상적으로 시작한 뒤 일시적인 네트워크 장애가 발생하면 로컬 Codex는 계속 실행됩니다.
- 전송하지 못한 숫자 사용량은 개인 컴퓨터의 비공개 spool 파일에 저장했다가 다음 실행 때 다시 전송합니다.
- 온라인 상태에서도 파일 확인 주기만큼 쿼터를 조금 초과할 수 있습니다.
- 서버나 네트워크가 끊긴 동안에는 중앙 차단을 적용할 수 없어 초과량이 커질 수 있습니다.
- 사용자가 원본 `codex`를 직접 실행하거나 로컬 프로그램을 수정하면 계량을 우회할 수 있습니다. 따라서 이 도구는 세 사용자가 래퍼 사용에 동의하는 **협력형 계량 방식**입니다.
- Codex 세션 삭제·손상, 갑작스러운 전원 차단, 향후 세션 형식 변경은 측정 정확도를 낮출 수 있습니다.
- 표시되는 사용량은 OpenAI의 공식 Pro/Codex 잔여량이나 청구 사용량이 아닙니다.

---

## English documentation

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
