# V2.1.3 product validation — M1 candidate replacement

Release-gate update: the personal-PC [real WSL Canary and final regression](v2-v213-real-wsl-canary.md)
are now PASS. The uploaded report explicitly records unchanged candidate
application code. This checkout matched the handed-off source archive before
adding the report. The NOT RUN/continuation sections below describe the earlier
server-side handoff, not the final Canary outcome.

Unreleased branch: `fix/v2.1-existing-codex-home`. Existing uncommitted work is
preserved; no commit, push, merge, tag, release or production change.

## Product scope

Block ordinary stale/replaced Home attachment, wrong Account/Profile/Device/Group
attribution, unselected Home collection, path/symlink escapes, adopted content or
config/auth/session changes, local-path leaks and restart/stop/re-add corruption.
Do not expand into privileged local attacks, forged kernel/filesystem identity,
deliberate mount swaps, forensic atime preservation or a new platform sandbox.
Out-of-scope observations are recorded separately, not release blockers.

Adopted Home contract: Meter/Codex probes must not create/delete/rename files,
change contents/config/auth/sessions, or change mtime/ctime. Normal OS-maintained
atime changes due to read access are allowed. No O_NOATIME/native layer is added.

## M1 fix

The local candidate chooser previously retained Number dev/inode values without
creation identity. A displayed directory deleted/recreated at the same path could
reuse its inode and pass the stale selection check. Discovery and attachment now
reuse `existing-root.js` identity construction/comparison, already used by the
collector. Metadata is read with BigInt; exact decimal representations avoid
Number rounding and remain local-only. Canonical path, dev, inode and usable
creation identity must match; otherwise attachment returns `candidate_changed`
and instructs a fresh selection. Missing creation identity is not auto-approved.

The deterministic M1 regression deletes candidate A, creates replacement B at the
same path with 777 tokens, and models allocator reuse of dev/inode with a changed
creation identity. Attachment is rejected before selection/baseline/cursor/event
state changes. Explicitly discovering/selecting the replacement again succeeds,
baselines its old 777 tokens, and collects only the next 25 tokens. Precision,
missing-identity, unchanged selection, symlink and multi-account tests remain.
An additional synthetic native-filesystem replay actually reused the deleted
directory's inode (no metadata mocking), then rejected stale attachment with
zero selections/cursors/events. This validates the reproduced M1 locally, not a
real authenticated user Canary.

## Validation

Fresh runs after M1, with zero failures, cancellations or skips in each run:

| Check | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| npm test | 319 | 319 | 0 | 0 |
| V1 | 68 | 68 | 0 | 0 |
| V2 | 251 | 251 | 0 | 0 |
| Node 24.15.0 V2 | 251 | 251 | 0 | 0 |
| Candidate discovery focused | 7 | 7 | 0 | 0 |
| Existing Home / M1 attach | 29 | 29 | 0 | 0 |
| Collector focused | 40 | 40 | 0 | 0 |
| Quota portable | 7 | 7 | 0 | 0 |
| Quota enforced namespace | 36 | 36 | 0 | 0 |
| Native Codex fixture | 4 | 4 | 0 | 0 |
| npm Codex fixture | 4 | 4 | 0 | 0 |
| Multi-account / quota attribution | 70 | 70 | 0 | 0 |

These overlap; do not sum them as unique tests. Host Node 22.22.3; separate
required-version Docker execution uses Node 24.15.0. Syntax: 76 JS files PASS.
Shell installer, unstaged/staged diff checks: PASS. Production dependency audit:
0 vulnerabilities. Logs: `/tmp/codex-meter-m1-*.log`.

## Final product review

Fresh-context, review-only `gpt-6-astra` / `high`: **PASS**.
In-scope Critical 0 / High 0 / Medium 0 / Low 0. Reviewer read current diff,
untracked implementation/tests and integration source, and independently ran
83 related tests: passed 83, failed 0, skipped 0. Main verified the M1 source,
deterministic regression and actual native inode-reuse replay. No earlier review
verdict was reused. Ordinary atime updates are accepted, not findings; privileged
mount/identity attacks and theoretical hardening are outside this product gate.

## Actual WSL gate

After review PASS, `uname -a`, `/proc/version`, and `WSL_DISTRO_NAME` were checked.
Current machine: Linux x86_64, Ubuntu generic 6.8.0-136 kernel, no WSL marker or
distribution environment value. **Not WSL.** No SSH or Home discovery attempted.

Actual WSL attach, baseline, real usage, Account/Device/Group attribution, other
Home isolation, authenticated `account/read`, `account/rateLimits/read`, provider
windows, adopted content/mtime/ctime integrity, restart and stop/re-add: **NOT RUN**.
Synthetic test outcomes above must not be reported as real-user Canary outcomes.

## Continue on the personal PC

Use the source snapshot from this candidate in a new, separate WSL directory;
do not overwrite another dirty checkout. Read this report and the existing Home
and quota-isolation documentation. Do not change candidate code or expand the
threat model. Ask the user for the exact existing CODEX_HOME path before accessing
it. Do not search real Homes, aliases or launchers. Never read/parse/copy/hash
auth contents or reuse an old enrollment token.

Run an isolated Canary Server/Device/Profile with a new one-time enrollment and
separate Agent state. Keep production untouched. Validate real attach, EOF
baseline, one user-generated Codex task, correct attribution, authenticated quota,
selected-only tracking, restart, stop/re-add and preserved Meter history. Request
user login or actual Codex activity when needed; do not guess their launcher.
Exclude normal read atime changes, but require no Meter/probe content/config/auth/
session/mtime/ctime changes. Redact actual paths and credentials in the report.

After real Canary passes, run the requested final full regression and Node 24.15+
V2 again. Return the sanitized report to the original candidate worktree before
the authorized commit/push. A source-only snapshot has no `.git`, so is not itself
the branch to commit. No merge/tag/release/deploy is authorized.

ACTION REQUIRED: continue this candidate's real Canary in the personal PC WSL
where the existing Codex environments are used, and explicitly provide the Home
to measure. Current candidate remains uncommitted and unpushed.

## 한국어 요약

M1 수정 후 전체 319/319, V1 68/68, V2 및 Node 24.15 V2 각각 251/251을 새로
통과했습니다. fresh Astra high 제품 리뷰도 C/H/M/L 모두 0으로 통과했습니다.
현재 머신은 WSL이 아닌 일반 Ubuntu이므로 실제 개인 PC WSL에서 Canary를
이어가야 합니다. 실제 Home 자동 검색·임의 SSH·commit·push·배포는 하지 않았습니다.
소스 묶음은 새 폴더에 풀고 이 보고서를 Codex에 넘긴 뒤, 측정할 Home 경로를
직접 알려주세요. 후보 수정 없이 실제 attach/사용량/quota/재시작/stop-readd와
무변경 조건을 검증하고 최종 회귀를 통과한 후에만 원본 브랜치 commit/push가
가능합니다. 일반적인 atime 갱신은 합의한 제품 계약상 허용합니다.
