# Codex Meter

## V2 (recommended)

V2 is the recommended architecture: one persistent per-user Agent on each monitored computer and one Node.js 24.15+ Server providing both the Dashboard and versioned API. Devices operate concurrently; there is no lease and no invented token quota. The Agent counts newly observed `token_count.lastUsage` events from installation onward and delivers a privacy-allowlisted numeric event through a crash-safe SQLite outbox.

**Status:** the V2 MVP implementation, migrations, Dashboard, installers, Docker deployment, and release automation are present. Before a production rollout, run the [two-real-machine validation](docs/v2-validation.md) in your own Codex environment.

### Fast server start (Docker)

```sh
cp compose.v2.example.yml compose.yml
export CODEX_METER_ADMIN_PASSWORD='replace-with-a-long-random-password'
export CODEX_METER_SERVER_URL='https://meter.example.com'
export CODEX_METER_TRUSTED_PROXIES='127.0.0.1,::1' # exact reverse-proxy backend source IP(s)
docker compose up -d --build
curl http://127.0.0.1:3000/api/v1/health
```

Put an HTTPS reverse proxy in front of the loopback-bound port. Preserve `Host`, set exactly `X-Forwarded-Proto: https`, and list the proxy's exact backend source IP in `CODEX_METER_TRUSTED_PROXIES` (Docker bridge/NAT deployments may not appear as loopback). Plaintext enrollment and Agent sync are rejected with HTTP 426. The single service stores its WAL-mode SQLite database at `/data/meter.db`; back up that file using a SQLite-safe backup or a stopped-container copy. Open the Dashboard, create Groups, choose **Add Device**, and run the displayed one-line installer. Released Agents for Linux x64, Windows x64, and macOS arm64 are self-contained and require no global Node.js or npm on monitored computers.

### V2 semantics and caveats

- Account quota reporting is **read-only, optional, and may be stale or unavailable**. It is never estimated from token counts.
- Group percentage is the **share of locally measured token usage**, not exact OpenAI quota attribution or billing.
- Never upload Codex rollout JSONL or `auth.json`, including in support requests.
- Recognized inherited fork/subagent/revert history is skipped. Ambiguous inherited files are baselined, so they **undercount safely** rather than risk double-counting.
- SQLite is a **single-service MVP**. Do not run multiple Server replicas against `/data/meter.db`; no Redis, PostgreSQL, or queue is required.

V2 documentation: [architecture](docs/v2-architecture.md), [installation](docs/v2-installation.md), [deployment](docs/v2-deployment.md), [validation](docs/v2-validation.md), [privacy](docs/v2-privacy.md), and [troubleshooting](docs/v2-troubleshooting.md).

---

## V1 legacy wrapper documentation

Everything below describes V1. V1 remains tested for compatibility but is legacy: it requires launching Codex through a wrapper, assumes exactly three users, and uses leases/operator-defined quota behavior that V2 deliberately does not use.

[![Node.js 22](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Tests](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml/badge.svg)](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Codex Meter is a small, dependency-free quota and usage meter for **exactly three people** who each run and authenticate their own local [OpenAI Codex CLI](https://github.com/openai/codex).

It is **not an OpenAI plugin, OAuth proxy, or official billing tool**. It is a cooperative local wrapper plus a central Node.js server.

> 한국어 요약: 세 사람이 각자 본인의 Codex CLI와 계정을 그대로 사용하면서, 중앙 서버에서 사용량을 집계하고 필요할 때만 같은 한도를 적용하는 도구입니다. 프롬프트·응답·소스 코드·Codex 인증정보는 서버로 보내지 않고 숫자 토큰 카운터 5개만 전송합니다.

## 한국어 안내

### 어떤 도구인가요?

Codex Meter는 **세 명이 각자 개인 컴퓨터의 터미널에서 Codex CLI를 실행하되, 사용량은 중앙에서 사용자별로 집계하고 선택적으로 같은 쿼터를 적용**하기 위한 도구입니다.

실제 구성은 다음 두 부분으로 나뉩니다.

1. **개인 컴퓨터의 래퍼**가 Codex CLI를 대신 실행합니다.
2. **중앙 Meter 서버**가 세 사용자의 사용량, 쿼터, 실행 상태를 관리합니다.

```text
사용자 A/B/C의 개인 터미널
  └─ Codex Meter 래퍼
       ├─ 중앙 서버에 실행 허가 요청
       ├─ 본인 컴퓨터의 Codex CLI 실행
       ├─ 로컬 세션에서 token_count만 집계
       └─ 세션에서 추출한 숫자 사용량 5개만 중앙 서버에 보고

중앙 Meter 서버
  ├─ 사용자별 누적 사용량
  ├─ 관찰 모드 또는 세 명에게 동일한 쿼터 적용
  ├─ 사용자당 동시 실행 1개 제한
  ├─ 강제 모드의 쿼터 초과·모든 모드의 비활성 사용자 차단
  └─ 사용자용 조회 API와 관리자 대시보드
```

이 프로젝트는 **OpenAI 공식 플러그인이나 공식 사용량·과금 도구가 아닙니다.** Codex 앞에서 실행되는 협력형 로컬 래퍼와 별도의 중앙 관리 서버입니다.

### 사용량은 자동으로 수집됩니다

사용자가 토큰 수치나 사용 내역을 직접 입력할 필요는 없습니다. 사용자에게 필요한 수동 설정은 최초 한 번 `client.json`에 중앙 서버 주소와 본인의 Meter 토큰을 저장하는 것뿐입니다.

이후 Codex Meter 래퍼를 실행할 때마다 다음 과정이 자동으로 진행됩니다.

1. 중앙 서버에 실행 가능 여부를 확인하고 사용자 lease를 받습니다.
2. 래퍼가 같은 터미널에서 사용자의 로컬 Codex CLI를 실행합니다.
3. 기본 **5초 간격**으로 로컬 Codex 세션 JSONL을 다시 확인합니다.
4. 새로 발생한 `token_count`의 다섯 카운터 차이를 자동 계산해 중앙 서버에 전송합니다.
5. 강제 모드에서는 쿼터 초과 응답을 받으면 실행 중인 Codex를 중지합니다. 관찰 모드에서는 사용량만 기록합니다.
6. Codex가 끝나면 최종 사용량과 실행 종료를 자동 보고합니다.
7. 일시적인 전송 실패는 로컬 spool에 보관했다가 다음 실행 때 자동 재전송합니다.

따라서 `/v1/usage` 호출이나 관리자 대시보드는 **사용량을 입력하는 기능이 아니라 이미 자동 수집된 결과를 조회하는 기능**입니다. 다만 계량이 적용되려면 사용자가 원본 `codex` 대신 Codex Meter 래퍼를 통해 실행해야 합니다.

### 개인정보와 인증정보

각 사용자는 자신의 컴퓨터에 Codex CLI를 설치하고 직접 인증합니다. Codex Meter는 Codex OAuth 토큰과 `auth.json`을 읽거나 복사하거나 서버로 보내지 않습니다.

래퍼는 로컬 Codex 세션 JSONL을 한 줄씩 읽고 각 레코드를 파싱해 `token_count` 이벤트인지 확인합니다. 프롬프트·응답·도구 실행·소스 내용 등 `token_count`가 아닌 레코드는 로컬에서 즉시 버리며, 저장하거나 중앙 서버로 전송하지 않습니다. 세션에서 추출해 전송하는 사용량 정보는 다음 숫자 5개뿐입니다.

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

세 명의 사용량을 대략 비교하는 목적이라면 **관찰 전용 모드**로 최초 한 번 초기화합니다. 이 모드는 토큰을 기록하지만 임의의 토큰 한도로 Codex를 중지하지 않습니다.

```sh
export CODEX_METER_STATE="$HOME/.codex-meter-server/state.json"
umask 077
node bin/admin.js init \
  --users=alice,bob,carol \
  --observe-only \
  --reset-ms=2592000000 \
  --max-leases=1 \
  --lease-ttl-ms=120000 \
  > meter-tokens-once.json
```

예시는 30일마다 측정 카운터만 초기화합니다. 강제 토큰 정책이 필요할 때만 `--observe-only` 대신 `--quota=원하는_양의_정수`를 사용하세요. 이 값은 OpenAI 플랜 한도가 아니라 운영자가 정하는 로컬 정책입니다.

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
mkdir -p "$HOME/.local/bin"
ln -s "$(pwd)/clients/unix/codex-meter" "$HOME/.local/bin/codex-meter"
```

이제 원래 `codex`를 실행하던 자리에 래퍼를 사용합니다.

```sh
/path/to/codex-meter/clients/unix/codex-meter
/path/to/codex-meter/clients/unix/codex-meter --model MODEL_NAME "작업 내용"
codex-meter
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

PowerShell 래퍼와 Node.js 래퍼는 인수를 배열로 전달하며 `cmd.exe`를 호출하지 않습니다. 기본적으로 네이티브 `codex.exe`를 우선 사용합니다. 표준 npm 설치의 `codex.cmd`만 있으면 인접한 공식 `@openai/codex/bin/codex.js`를 Node.js로 직접 실행합니다. 설치 위치가 특수하면 `CODEX_METER_CODEX`에 `.cmd`가 아닌 네이티브 `codex.exe` 전체 경로를 지정하세요.

### 4. 사용량 확인과 사용자 관리

브라우저에서 서버 루트 주소를 열고 자신의 Meter 토큰을 입력하면 본인 사용량만 조회할 수 있습니다. 이 토큰은 OpenAI API 키가 아니라 서버 초기화 때 별도로 발급되는 Meter 전용 자격 증명이며, 웹 화면은 토큰을 URL·쿠키·브라우저 저장소에 보관하지 않습니다.

```sh
curl --oauth2-bearer USER_METER_TOKEN \
  https://meter.example.internal/v1/usage
```

관리자는 같은 루트 화면의 관리자 로그인에 Admin Meter 토큰을 입력해 전체 대시보드를 조회하거나, 인증된 JSON API를 사용할 수 있습니다.

```sh
curl --oauth2-bearer ADMIN_METER_TOKEN \
  https://meter.example.internal/admin.json
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
- 인증 실패나 잘못된 요청 같은 영구적인 HTTP 4xx 오류가 발생하면 래퍼가 Codex 실행을 중지합니다.
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
- Supports observe-only measurement or one configurable quota applied equally to all three users; both modes use the same reset period.
- Allows one active wrapper per user.
- Denies a new run when the user is disabled or already active; enforcement mode also denies users who are out of quota.
- In enforcement mode, stops a connected run after its measured usage crosses the quota.
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

For rough relative measurement, initialize the state once in **observe-only mode**. This records tokens but never stops Codex at an arbitrary token threshold. Exactly three unique user IDs are mandatory:

```sh
export CODEX_METER_STATE="$HOME/.codex-meter-server/state.json"
umask 077
node bin/admin.js init \
  --users=alice,bob,carol \
  --observe-only \
  --reset-ms=2592000000 \
  --max-leases=1 \
  --lease-ttl-ms=120000 \
  > meter-tokens-once.json
```

The example resets only the measurement counters every 30 days. If you intentionally want local enforcement, replace `--observe-only` with `--quota=YOUR_POSITIVE_INTEGER`. That value is an operator-defined local policy, not an OpenAI plan limit.

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
mkdir -p "$HOME/.local/bin"
ln -s "$(pwd)/clients/unix/codex-meter" "$HOME/.local/bin/codex-meter"
```

Use the wrapper anywhere you would normally use `codex`:

```sh
/path/to/codex-meter/clients/unix/codex-meter
/path/to/codex-meter/clients/unix/codex-meter --model MODEL_NAME "your prompt"
codex-meter
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

A user can open the server root URL and enter their Meter token to see only their own usage. This is a meter-specific credential issued during server initialization, not an OpenAI API key. The page does not store it in a URL, cookie, local storage, or session storage. The authenticated JSON API remains available:

```sh
curl --oauth2-bearer USER_METER_TOKEN \
  https://meter.example.internal/v1/usage
```

The administrator enters the Admin Meter token in the root page to open the aggregate dashboard, or reads the authenticated JSON API:

```sh
curl --oauth2-bearer ADMIN_METER_TOKEN \
  https://meter.example.internal/admin.json
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
