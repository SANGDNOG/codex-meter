# Codex Meter

[영문 문서](README.md)

[![Tests](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml/badge.svg)](https://github.com/SANGDNOG/codex-meter/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Codex Meter는 여러 Device와 Account Profile에서 사용하는 OpenAI Codex CLI의 사용량을 자체 서버에서 집계하는 개인정보 보호 중심 도구입니다.

Codex Meter V2.1은 등록된 Device마다 백그라운드 Agent 하나를 실행합니다. Agent는 사용자가 명시적으로 선택한 Codex 환경에서 숫자 토큰 카운터만 수집해 중앙 Server로 전송합니다. Server는 Dashboard, Account 및 Group 귀속, quota 관측, 기간별 사용량을 제공합니다.

Codex Meter는 OpenAI의 공식 과금 제품, 계정 식별 서비스, OAuth 프록시 또는 quota 강제 시스템이 아닙니다. Account Profile은 Codex Meter 관리자가 붙이는 이름입니다. Codex Meter는 현재 로그인된 provider account가 누구인지 자동으로 식별하지 않습니다.

## V2.1 주요 기능

- 등록된 Device마다 지속 실행되는 Agent 하나를 사용하며 일반적인 Codex 실행에 wrapper가 필요하지 않습니다.
- Dashboard에서 Device 설정을 선언하고 `agent.json` 편집이나 Agent 재시작 없이 적용합니다.
- Device의 현재 Codex 로그인을 추적하는 간단한 흐름을 제공합니다.
- 한 Device에서 여러 Account Profile을 사용할 수 있도록 서로 격리된 Codex 환경을 만듭니다.
- 지원 플랫폼에서 사용자 권한 서비스와 launcher를 자동 생성합니다.
- 명시적 opt-in 방식으로 선택된 환경만 추적합니다.
- Account, Device, 과거 Group membership 기준으로 사용량을 귀속합니다.
- provider quota를 읽기 전용으로 관측하고 stale/unavailable 상태를 구분합니다.
- 로컬에서 추적한 token share를 기준으로 quota contribution을 추정합니다.
- 장애에 안전한 cursor, SQLite outbox, at-least-once 전송, Server 중복 제거를 제공합니다.
- 기존에 Codex Meter가 관리하던 환경은 별도 작업 없이 migration합니다.

## 추적 범위

Codex Meter는 관리자가 Device에서 Meter Account Profile에 명시적으로 연결한 Codex 환경만 측정합니다.

예를 들어 한 컴퓨터에 다음 launcher가 있을 수 있습니다.

```text
cx1 -> Account A
cx2 -> Account B
cx3 -> Account C
```

Codex Meter에 `Personal -> cx1`만 등록했다면 해당 환경에만 collector, watcher, quota reporter 및 Server attribution이 활성화됩니다. `cx2`와 `cx3`는 Codex Meter의 관리 범위 밖에 그대로 남습니다.

추적하지 않는 환경에 대해 Codex Meter는 다음 작업을 하지 않습니다.

- Codex home 검색 또는 검사
- 인증 상태 확인
- baseline 또는 managed marker 생성
- `config.toml`, 인증 파일 또는 session 파일 변경
- collector, watcher 또는 quota reporter 실행
- 경로, launcher, account 또는 usage를 Server에 보고

launcher나 `CODEX_HOME`이 존재한다는 사실은 추적 동의가 아닙니다. Legacy migration은 Codex Meter 자체 로컬 설정에 이미 등록된 환경만 가져옵니다.

한 가지 compatibility 동작은 의도적으로 유지합니다. 최초 declarative configuration이 적용되기 전 revision-0 V2.0.x Agent는 Meter configuration에 이미 기록돼 있던 단일 default Codex home을 계속 추적합니다. 이는 기존 Meter-managed assignment를 보존하는 동작이며 컴퓨터 전체를 검색하는 기능이 아닙니다. 명시적으로 import된 profile이 있으면 해당 profile이 이 fallback보다 우선합니다. 빈 revision을 포함해 declarative revision 1 이상이 한 번이라도 적용되면 default fallback은 비활성화됩니다.

## 구조

```text
명시적으로 선택된 Codex 환경
  -> 로컬 rollout parser
  -> transaction 기반 cursor + SQLite outbox
  -> HTTPS Agent sync
  -> Codex Meter Server
  -> Account / Device / Group 화면

Codex App Server의 읽기 전용 작업
  -> 정규화된 quota 관측
  -> HTTPS Agent sync
  -> Account quota 및 cycle 추정치
```

Agent는 active 및 archived rollout 파일을 감시하고 주기적으로 다시 확인합니다. 명시적으로 허용된 `token_count.lastUsage` 필드만 parsing합니다. Cursor 이동과 outbox 추가는 하나의 transaction으로 처리됩니다. 안정적인 event ID와 Server의 unique constraint가 retry 또는 restart 중 중복 집계를 막습니다.

Server는 Node.js 24.15+ 단일 process로 Dashboard와 `/api/v1/**`를 함께 제공합니다. Versioned migration과 WAL mode를 사용하는 SQLite에 데이터를 저장합니다. 하나의 database에 Server process를 둘 이상 실행하면 안 됩니다.

데이터와 귀속 규칙은 [V2 architecture](docs/v2-architecture.md)를 참고하십시오.

## 지원 플랫폼

| 구성 요소 | 지원 환경 |
| --- | --- |
| Server | Node.js 24.15+ Docker 또는 Node.js 24.15+ 직접 실행 |
| Agent | Linux x64 |
| Agent | macOS arm64 |
| Agent | Windows x64 |

Release Agent는 자체 실행 가능한 binary입니다. 추적할 컴퓨터에는 Codex CLI가 필요하지만 전역 Node.js, npm 또는 repository checkout은 필요하지 않습니다.

## 사용자 onboarding

일반 onboarding은 최대 네 단계입니다.

1. Dashboard에서 **Add Device**를 선택합니다.
2. 추적할 Account Profile과 login 방식을 선택합니다.
3. 화면에 표시된 설치 명령을 실행합니다.
4. Device에 **Login required**가 표시되면 상세 화면에 나온 정확한 login 명령을 실행합니다.

사용자가 Account UUID를 입력하거나, `CODEX_HOME`을 만들거나, JSON을 편집하거나, binding ID를 복사하거나, 서비스를 직접 재시작할 필요가 없습니다.

### 이 Device의 현재 Codex login 사용

일반적인 단일 login 환경에서 선택합니다. Server는 Account Profile만 선언하며 로컬 경로를 받지 않습니다. Agent가 운영체제의 기본 Codex home을 사용합니다.

최초 binding 시 Agent는 기존 rollout의 현재 끝을 baseline으로 기록합니다. 이전 usage는 가져오지 않습니다. Binding 이후 기록된 event만 선택한 Account Profile에 귀속됩니다.

Agent는 기존 home의 `config.toml`, 인증 파일, session 또는 directory ownership을 변경하지 않으며 managed marker도 만들지 않습니다.

### 별도의 Codex login 추가

같은 Device에서 별도로 추적할 Account Profile이 필요할 때 선택합니다. Agent가 다음 항목을 생성합니다.

- Codex Meter 전용 private Codex home
- 해당 home 내부의 managed ownership marker
- 필요한 credential-store 설정
- `cx2`와 같은 안전한 logical launcher
- 해당 assignment의 collector, watcher 및 quota reporter

인증이 필요하면 Device 화면에 지원 운영체제별 명령이 표시됩니다. 해당 Device의 운영체제에 맞는 명령을 실행합니다.

```sh
# Linux
"$HOME/.local/bin/cx2" login

# macOS
"$HOME/Library/Application Support/Codex Meter/cx2" login
```

```powershell
# Windows PowerShell
& "$env:LOCALAPPDATA\CodexMeter\cx2.ps1" login
```

Codex Meter는 자동으로 로그인하지 않으며 provider credential을 요구하거나 복사하지 않습니다.

### 추가, 재연결 및 추적 중지

Account Profile을 추가하거나 추적을 중지하면 새 desired configuration revision이 생성됩니다. 실행 중인 Agent가 다음 sync에서 이를 적용합니다. 새 revision 적용에 실패하면 `apply_failed`를 보고하고 기존의 정상 assignment는 계속 실행합니다.

**Stop tracking**은 해당 binding의 향후 수집, 감시 및 quota 보고를 중단합니다. 로컬 Codex login, Codex home, launcher, session, 기존 Meter usage, cursor, pending outbox record 또는 quota history는 삭제하지 않습니다.

Account Profile을 다시 연결하면 전환 전 event는 이전 binding에 그대로 남습니다. 새 binding은 전환 시점의 baseline부터 시작하며 과거 usage를 다시 귀속하지 않습니다.

## Dashboard 상태

Device 화면은 추적하는 Account Profile을 관리하는 중심 화면이며 다음 상태를 구분합니다.

- Agent 연결 대기
- 설정 적용 중
- 추적 중
- login 필요
- quota 사용 불가
- Agent offline
- configuration 적용 실패
- 추적 중지 대기

Account 화면은 measured usage, 현재 quota, 등록된 Device의 reporting coverage, Device별 사용량, 과거 Group 귀속 및 현재 cycle 추정치를 보여줍니다. Configuration 적용에 실패하더라도 last-known-good revision에서 계속 실행 중인 assignment를 사라진 것처럼 표시하지 않습니다.

## Server 배포

### 요구 사항

- Docker Compose 또는 Node.js 24.15 이상
- `/data/meter.db`를 보존할 directory 또는 volume
- enrollment 및 Agent sync에 사용할 public HTTPS origin
- 하나의 `v2-agent-*` GitHub Release에서 받은 파일 5개
- 환경 변수로 전달하는 길고 고유한 관리자 password

### 하나의 완전한 Agent release 다운로드

서로 다른 release의 manifest와 binary를 섞지 마십시오. 다음 staging 명령은 Linux Server host 또는 WSL 기준입니다.

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

배포하기 전에 세 binary가 모두 `OK`인지 확인합니다.

macOS Server host에서는 `sha256sum --check SHA256SUMS` 대신 `shasum -a 256 -c SHA256SUMS`를 사용합니다. Native Windows Server host에서는 아래 명령을 WSL에서 실행하거나 PowerShell의 `Get-FileHash -Algorithm SHA256`로 각 binary를 `SHA256SUMS`의 해당 값과 대조한 뒤 Server를 시작합니다.

### Docker Compose로 실행

```sh
cp compose.v2.example.yml compose.yml
export CODEX_METER_ADMIN_PASSWORD='replace-with-a-long-random-password'
export CODEX_METER_SERVER_URL='https://meter.example.com'
export CODEX_METER_TRUSTED_PROXIES='127.0.0.1,::1'
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/v1/health
curl -fsS http://127.0.0.1:3000/api/v1/agent/releases/manifest.json
```

예제는 3000 port를 loopback에 binding하고 SQLite volume을 `/data`, `./releases`를 read-only `/releases`에 mount합니다.

Server 앞에는 신뢰할 수 있는 HTTPS reverse proxy를 배치합니다. `Host`를 유지하고 `X-Forwarded-Proto: https`를 정확히 설정하며 proxy의 실제 backend source IP만 `CODEX_METER_TRUSTED_PROXIES`에 추가합니다. CIDR이나 임의의 forwarded header는 신뢰하지 않습니다. 직접적인 plaintext enrollment 및 sync 요청은 거부됩니다.

Release 제공, backup, restore 및 reverse proxy 요구 사항은 [V2 Server deployment](docs/v2-deployment.md)를 참고하십시오.

### Node.js로 직접 실행

직접 배포할 때는 production dependency를 설치하고 같은 release directory를 명시적으로 지정합니다.

```sh
npm ci --omit=dev
mkdir -p data releases
export CODEX_METER_ADMIN_PASSWORD='replace-with-a-long-random-password'
export CODEX_METER_SERVER_URL='https://meter.example.com'
export CODEX_METER_TRUSTED_PROXIES='127.0.0.1,::1'
export CODEX_METER_DB="$PWD/data/meter.db"
export CODEX_METER_RELEASE_DIR="$PWD/releases"
export CODEX_METER_HOST='127.0.0.1'
export CODEX_METER_PORT='3000'
node bin/v2-server.js
```

시작 전에 `releases`에 필요한 파일을 넣고 checksum을 검증합니다. 하나의 service supervisor 아래에서 process를 실행하고 HTTPS reverse proxy 뒤의 loopback에 binding하며, 같은 SQLite database에 두 번째 process를 실행하지 마십시오.

## 첫 Device 생성

1. Public HTTPS Server URL을 열고 관리자 password로 로그인합니다.
2. 조직에서 사용할 Account Profile과 Group을 생성합니다.
3. **Devices**에서 **Add Device**를 선택하고 Device 이름과 Account Profile 하나를 지정합니다.
4. 현재-login 또는 별도-login 방식을 선택해 Device를 생성합니다.
5. 생성된 명령을 해당 Device에서 실행합니다.
6. **Tracking** 상태를 기다리거나 표시된 **Login required** 명령을 실행합니다.

설치 명령의 enrollment token은 짧은 시간만 유효하고 한 번만 사용할 수 있습니다. Server는 hash만 저장합니다. 성공적인 enrollment는 token을 Device credential로 교환하며, 이 credential은 권한이 제한된 Agent local configuration에 저장되고 URL query에는 포함되지 않습니다.

## Agent 운영

Installer는 사용자 권한 systemd service, LaunchAgent 또는 최소 권한 Windows scheduled task를 등록합니다. 설치 directory가 `PATH`에 없어도 실행되도록 다음과 같이 전체 경로를 사용합니다.

```sh
# Linux
"$HOME/.local/bin/codex-meter-agent" status
"$HOME/.local/bin/codex-meter-agent" update

# macOS
"$HOME/Library/Application Support/Codex Meter/codex-meter-agent" status
"$HOME/Library/Application Support/Codex Meter/codex-meter-agent" update
```

```powershell
# Windows PowerShell
& "$env:LOCALAPPDATA\CodexMeter\codex-meter-agent.exe" status
& "$env:LOCALAPPDATA\CodexMeter\codex-meter-agent.exe" update
```

`update`는 설정된 Server에서 manifest와 해당 플랫폼 binary를 내려받고 SHA-256을 검증한 뒤 executable을 원자적으로 교체합니다. 검증 실패 시 기존 executable을 유지합니다.

Account Profile 측정만 중단하려면 **Stop tracking**을 사용하십시오. `uninstall --yes`는 Agent service, executable, configuration 및 Agent database를 제거합니다. Codex data를 삭제하지 않도록 managed Codex home, credential, session 및 생성된 launcher는 의도적으로 보존하며 이후에는 추적되지 않습니다.

## Usage와 귀속

Codex Meter는 input, cached input, optional cache-write input, output, reasoning output 및 total token을 canonical decimal string으로 기록합니다. 화면의 합계는 `totalTokens`이며 다른 dimension을 다시 더하지 않습니다.

- **Account attribution**은 event 시점의 명시적 Account Profile binding을 사용합니다.
- **Device attribution**은 enrollment된 Agent credential을 사용합니다.
- **Group attribution**은 upload 시각이 아니라 `occurredAt` 당시 Device의 Group membership을 사용합니다.
- **Offline usage**는 local outbox에 남고 재연결 후 replay됩니다.
- **Duplicate delivery**는 idempotent하게 처리되어 합계가 두 번 증가하지 않습니다.

Device를 다른 Group으로 이동해도 과거 usage를 다시 쓰지 않습니다. 늦게 upload된 event도 event 발생 당시 Device가 속했던 Group에 귀속됩니다.

## Quota와 estimated contribution

Quota 보고는 읽기 전용이며 선택 사항이고 measured token과 별개의 정보입니다. 지정된 Agent는 Codex App Server의 고정된 operation만 사용해 initialize, account availability 확인 및 rate limit 조회를 수행합니다. Codex Meter는 token을 provider quota로 변환하지 않습니다.

Dashboard는 다음 정보를 표시합니다.

- provider가 보고한 usage 및 reset 시각
- 로컬에서 추적한 token
- Group별 tracked share
- 명시적으로 등록된 Device의 tracking coverage
- estimated quota contribution

Estimated quota contribution은 provider가 보고한 Account usage를 로컬 tracked token 비율에 따라 배분한 추정치입니다. Provider가 직접 귀속한 정확한 usage 또는 billing data가 아닙니다.

이미 진행 중인 provider cycle에서 tracking을 시작하면 coverage는 `partial`입니다. Codex Meter는 시작 당시 provider percentage를 baseline으로 저장하고 이후 관측된 percentage-point 변화만 배분합니다. 현재 provider percentage 전체를 새 usage에 배분하지 않습니다.

Meter에 등록한 적 없는 컴퓨터나 환경은 tracking coverage의 denominator에 포함하지 않습니다.

## 개인정보 보호 및 보안

Local parser는 명시적 allowlist를 사용합니다. Event timestamp, 숫자 token counter, 제한된 optional model 또는 reasoning metadata만 전송할 수 있습니다. Prompt, response, message, source code, tool argument, tool output, working directory, repository 이름, 임의의 rollout field, OAuth credential 또는 `auth.json`은 저장하거나 전송하지 않습니다.

추가 보호 수단은 다음과 같습니다.

- enrollment 및 Agent sync에 HTTPS 필수
- 짧은 유효 기간과 1회 사용만 허용하는 hashed enrollment token
- Server에서 hash로 보호하는 administrator password 및 Device secret
- 권한이 제한된 Agent configuration과 state
- declarative configuration에서 remote filesystem path, executable, command, script 또는 environment variable 금지
- 고정된 read-only quota operation
- 로컬 Codex 환경 자동 검색 금지

Bug report, CI artifact 또는 support 요청에 rollout JSONL, `auth.json`, Device credential 또는 administrator credential을 올리지 마십시오. 자세한 내용은 [V2 privacy model](docs/v2-privacy.md)을 참고하십시오.

## Backup과 복구

Server upgrade 전에는 production SQLite database를 반드시 backup합니다. SQLite online backup API/tool을 사용하거나 Codex Meter Server만 중지한 뒤 `meter.db`와 WAL sidecar를 하나의 일관된 단위로 복사합니다. Backup integrity를 확인하고 restore도 시험해야 합니다.

Schema version을 되돌릴 때는 이전 Server runtime과 해당 upgrade 직전 database backup을 함께 restore해야 합니다. Compatibility가 명시적으로 증명되지 않았다면 migration된 database에 이전 Server를 실행하지 마십시오.

Agent는 일반적인 restart 동안 cursor와 pending outbox event를 보존합니다. 연결 문제를 해결하기 위해 `agent.db`를 삭제하지 마십시오.

## 문제 해결

- **Agent inactive:** Agent 운영 절의 해당 플랫폼용 `status` 명령을 실행하고 사용자 service log를 확인합니다.
- **Login required:** Device 화면의 정확한 명령을 실행합니다. Home 사이에 인증 파일을 복사하지 마십시오.
- **Usage가 증가하지 않음:** 설치 전 history는 의도적으로 제외됩니다. 새 작업 후 reconcile 및 sync interval 한 번을 기다립니다.
- **Pending event:** HTTPS, DNS, certificate trust, Device 상태 및 Server health를 확인합니다. Outbox가 자동으로 retry합니다.
- **Configuration apply failed:** 이전의 정상 configuration이 계속 실행됩니다. 보고된 local filesystem 또는 launcher conflict를 해결한 뒤 Agent retry를 기다립니다.
- **Quota unavailable 또는 stale:** 활성화된 등록 Device가 보고 중인지와 해당 Codex login을 사용할 수 있는지 확인합니다. Stale quota를 현재 값으로 해석하지 마십시오.
- **Server restart loop:** 최초 실행 administrator password, volume ownership, disk 여유 공간 및 하나의 Server만 database를 쓰는지 확인합니다.
- **Checksum failure:** 현재 Agent executable을 유지하고 전체 release directory를 검증한 뒤 다시 시도합니다. 검증을 우회하지 마십시오.

운영 관련 상세 내용은 [V2 troubleshooting](docs/v2-troubleshooting.md)을 참고하십시오.

## 개발 및 검증

Node.js 24.15 이상을 사용합니다.

```sh
npm ci
npm test
npm run test:v1
npm run test:v2
npm run check:syntax
sh -n v2/install/install.sh
npm audit --omit=dev
```

`v2-agent-*` 형식의 release tag는 Linux x64, Windows x64, macOS arm64 native build, standalone executable smoke test, deterministic manifest 생성, checksum 검증 및 GitHub Release publish workflow를 실행합니다.

실제 환경 검증 중에도 `auth.json`을 복사하거나 읽으면 안 됩니다. [V2 validation guide](docs/v2-validation.md)를 따르십시오.

## Legacy V1

V1은 compatibility test를 위해 repository에 남아 있습니다. Foreground wrapper, 정확히 세 명의 설정 사용자, lease 및 선택적인 운영자 정의 token quota를 사용합니다. 이 동작은 V2.1의 동작이 아닙니다. 신규 배포는 V2.1을 사용하십시오.

## License

[MIT](LICENSE)
