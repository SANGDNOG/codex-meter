# Connect an existing Codex environment

This is an unreleased 2.1.3 candidate. It does not change published artifacts.

In **Add device**, choose your Account Profile and **Use an existing Codex
environment**, then run the freshly generated installation command on that
device. On a terminal, the installer asks which existing environment directory
to use. For example, enter `/home/you/.codex-profiles/cx1` on WSL (Linux x64).
Do not reuse an enrollment token from a log or previous conversation.

If there is no interactive terminal, the installer prints `ACTION REQUIRED`
followed by the exact installed Agent command. Run it locally. For an already
installed device, use:

```sh
codex-meter-agent profile attach-existing
```

Choose a Profile by its displayed name/number if more than one is waiting, then
enter its existing environment directory. At the path prompt, enter **?** to
find local candidates instead, or start the chooser directly:

```sh
codex-meter-agent profile attach-existing --discover
```

This explicit action checks `~/.codex` and lists only immediate directories in
`~/.codex-home` and `~/.codex-profiles`. It does not scan the entire Home or follow
directory symlinks. For other layouts, specify the parent folder locally
(`--search-root` may be repeated, up to 16 locations):

```sh
codex-meter-agent profile attach-existing --discover --search-root /your/profiles
```

Custom search roots replace the default locations. Results are **unverified
directory candidates**, not detected account identities or email addresses.
Only directory metadata is inspected; auth, config and session contents are not
opened while finding candidates. Choose a numbered directory, `0` to enter a
path manually, or `c` to cancel. There is no automatic attachment, even for a
single result. Searches are bounded to 512 directory entries and 100 candidates;
a partial-result warning asks you to narrow the search when a limit is reached.
If the displayed directory is replaced or redirected before attachment, the
Agent refuses it with `candidate_changed` and asks you to search again. Candidate
selection reuses the collector's local identity helper: canonical path, exact
device/inode values and usable creation identity must still match. BigInt stat
values are retained as lossless decimal strings, not rounded Numbers. A missing
creation identity is not silently accepted. Installer controlling-terminal
menus stay on that terminal even when ordinary stdout is redirected to a log.
No terminal means no search: run the printed command in an interactive terminal.
The installation path prompt supports the same **?** action.

Automation can explicitly supply the
local directory (and, if needed, the exact Profile name):

```sh
codex-meter-agent profile attach-existing --profile Personal \
  --codex-home "$HOME/.codex-profiles/cx1"
```

No Account UUID, JSON edit, environment-variable workaround, or service restart
is required. The running Agent picks up the selection at its next reconciliation
or heartbeat. It reports **Tracking**, or **Login required** if the selected
environment needs a login. In that case use your usual existing launcher to sign
in. Meter does not create a launcher for this mode, verify the provider identity,
or infer the provider account from the directory name.

Only the selected environment is tracked. A background Agent never discovers
other environments. The opt-in local chooser lists directory metadata only;
candidate lists are neither stored in the Agent database nor sent to the server.
Shell aliases, launchers and wildcard directories are not inspected. The selected canonical
directory is stored only in the Agent database; desired configuration, actual
state, usage and quota payloads do not contain that directory. Server-side
Profile names are user-entered labels: do not put private paths in those labels.

Existing files are baselined at EOF before attachment becomes active; only
subsequent usage is measured. Meter does not modify config, auth, sessions,
permissions, managed markers or existing launchers. Paths must exist and be
directories; canonical duplicates and overlapping tracked roots are rejected.
Aliases to a directory are canonicalized locally. Symlinked session roots are
rejected, and nested symlinks are not followed into other environments.

Adopted Home integrity contract: no Meter/Codex probe may create, delete, rename
or modify file contents, configuration, auth, sessions, mtime or ctime in an
adopted existing Home. Normal read access may be reflected in OS-maintained
access-time metadata (`atime`); preserving atime is not a release requirement.
Real-user Codex activity is distinguished from Meter/probe mutations during
Canary checks. This product does not promise protection against privileged
local attackers, forged filesystem identities, deliberate mount replacement,
forensic metadata preservation or a cross-platform filesystem sandbox.

**Stop tracking** disables collection and quota probes, preserving both local
data and historical Meter usage. Re-adding requires a new local selection and
fresh baseline, including when the Agent missed the intervening stop revision.

The original **current login** behavior still uses the installation's default
environment. **Add another Codex login** still creates a managed isolated home
and launcher. Old Agents wait for an upgrade when existing environments are
requested; a distinct compatible revision preserves supported active Profiles and
honors their explicit stops. Upgrading always advances to a complete revision.
A separate capability header leaves the older
strict capability format unchanged.

## Overview quota tabs

Tabs show the provider's limit identifier plus its reset period, such as
`codex · Weekly`, `codex_bengalfox · 5H`, and `codex_bengalfox · Weekly`.
These are distinct provider-reported quota windows, not three independent local
token counters. Identifiers are displayed verbatim as text; Meter does not
guess what an undocumented identifier means. Selecting a tab changes the quota
window used for the existing cycle estimate. Local measured usage and attribution
formulas are unchanged.

## 한국어

표시된 후보 폴더가 선택 전에 삭제·재생성되면 inode가 같더라도 생성 식별자가
달라진 후보는 `candidate_changed`로 거부합니다. 다시 검색해 명시적으로
선택해야 합니다. 기존 Home의 내용·설정·인증·세션·mtime·ctime 변경은 금지하며,
일반적인 읽기로 OS가 갱신하는 atime은 허용합니다. 이번 출시에서 atime 보존이나
관리자 권한 공격자 방어를 위한 별도 보안 계층은 추가하지 않습니다.

웹에서 **기기 추가 → 계정 프로필 → 기존 Codex 환경 사용**을 선택한 뒤 새 설치
명령을 해당 기기에서 실행하세요. 설치 중 평소 사용하는 환경 경로 하나만
입력합니다. 경로 입력 대신 **?**를 입력하면 로컬 후보를 찾아 번호로 선택할 수
있습니다. 또는 `codex-meter-agent profile attach-existing --discover`를 실행하세요.
기본 범위는 `~/.codex`, `~/.codex-home`과 `~/.codex-profiles`의 바로 아래 폴더이며,
다른 위치는 `--search-root`로 상위 폴더를 지정합니다. 후보는 폴더 목록일 뿐
실제 로그인 계정을 확인한 결과가 아닙니다. `c`를 선택하면 연결하지 않고 취소합니다.
터미널 입력이 불가능하면 출력된 `ACTION REQUIRED` 명령을 실행하세요.
이미 설치했다면 `codex-meter-agent profile attach-existing`을 사용합니다.

선택 경로는 해당 기기에만 저장되며 서버에 보내지 않습니다. 후보 목록은 저장하거나
서버로 보내지 않으며 사용자가 찾기를 실행할 때만 디렉터리 정보로 확인합니다.
선택하지 않은 환경은 추적하지 않습니다. 기존 설정·로그인·실행 명령은 그대로 유지하며, 연결 이전의
사용량은 제외됩니다. 수동 JSON 수정이나 서비스 재시작은 필요하지 않습니다.
로그인이 필요하면 원래 사용하던 Codex 실행 명령으로 로그인하세요.

개요의 주간/5시간 탭은 제공자가 보고한 서로 다른 한도 구간입니다. 같은 주간이라도
한도 식별자가 다르면 별도 항목이므로 삭제하지 않고 식별자를 함께 표시합니다.
