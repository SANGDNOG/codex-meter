# Existing Home collector isolation — unreleased candidate

Historical collector-fix report. The subsequent product-scope M1 correction and
accepted atime contract are tracked in [V2.1.3 product validation](v2-v213-product-validation.md).
Numbers and reviewer availability below describe the earlier iteration.

Scope: close the confirmed collector TOCTOU finding. Quota runner design,
attribution formula, default/managed-isolated modes and protocol remain unchanged.
No commit, push, merge, tag, release or production deployment.
Recovery diff: `/tmp/codex-meter-pre-collector-isolation-fix.patch` (tracked diff).

## Failure and regression

The old path was canonical validation, then pathname-based discovery and reopen.
A concurrent local writer replacing selected A's sessions directory with a link
to B during that gap caused B's 777 tokens to enter A's outbox. The focused suite
contains an explicit negative control retaining that unsafe path: it must
reproduce 777, so the test does not merely accept a broken collector as success.
The protected regression rejects the same swap with unchanged database state,
then collects A's new 25 tokens after the original tree is restored.

## Read boundary

`ExistingReadBoundary` is private to each existing-Home discovery/reconciliation.
The attached Home may originally be a user-created link; attachment still
canonicalizes it. Only the stored canonical root is used for collection.
Attachment also saves the root's device/inode/creation-time identity in Agent-local state in
the same transaction as the EOF baseline and selection. Reconciliation, watcher
registration and quota preflight use that saved identity, including after Agent
restart. They never silently acquire a replacement directory at the same path.
Older selections without an identity become `local_selection_required`; the
normal local selection command can explicitly reselect and establish a new EOF
baseline. Historical Meter usage is retained. No manual JSON edit is needed.

- Snapshot root, session directories, nested parents and candidate regular files
  using BigInt device/inode identities and nanosecond change-time values.
- Reject canonical escapes and untrustworthy identities; use `path.relative`
  boundaries, not string-prefix containment. Static nested/final symlinks are
  skipped without traversal. Replaced entries and shared/hardlinked rollouts
  fail closed. A link replacing a sessions root is rejected.
- On Linux, pin the canonical root with a component-by-component no-follow walk.
  Open directories and files through pinned parent descriptors with `O_NOFOLLOW`.
  Discovery enumeration also uses the pinned directory, not the original path.
- Verify the opened regular file with `fstat`, compare path/component identities
  and canonical containment before content reads, and read only that handle.
  Classification, EOF checks and incremental JSONL reads never reopen a pathname.
- Revalidate after each read, after parsing and before committing the pass.
  Directory change times also reject one-way swaps and swap-and-restore cases.
- Hold prospective events, cursor updates and compressed-baseline changes in
  memory. Commit synchronously in one transaction only after all final checks.
  A rejection leaves no events, cursor advance or baseline rewrite. Failed reads
  are retried by ordinary reconciliation; no manual reattach/restart is required.
- Watch notifications remain hints; they trigger the same guarded reconciliation.
  No auth/config/launcher content is read or modified by this boundary. There are
  no explicit filesystem writes. OS access-time updates caused by read/enumerate
  remain a known limitation (see below). Local identities/paths never enter Meter
  wire events.

Directory and file handles close on success and failure. A discovery caller must
invoke its `close()` method; the collector owns this lifetime for normal use.
Concurrent ordinary appends preserve file identity and are supported: file
change time is not an immutability requirement for an append stream. Shrinkage,
identity/type/link changes, and directory changes still reject the pass. Directory
enumeration validates only its branch/ancestors; complete validation remains at
discovery completion and before commit to avoid quadratic filesystem work.

## Platform contract

The portable path requires usable directory/file handles, nonzero BigInt inode
IDs, device IDs and change times. It combines opened-handle identity with full
pre/post component and canonical checks; unavailable primitives fail closed,
never silently fall back to ordinary `readFile(path)`. Windows case comparisons
are case-insensitive. Symlink/junction escapes are rejected using `lstat` plus
canonical containment, including canonical-prefix-collision tests.

The focused tests explicitly exercise the portable branches under simulated
`win32` and `darwin` with real Linux handles, stable reads and rejected reparse/
swap-and-restore cases. **These are policy simulations, not native NTFS/APFS
execution.** Native Windows junction/reparse behavior is not established by this
host. Node documents BigInt identities/change times and Windows junction types
in its [filesystem API](https://nodejs.org/api/fs.html); timestamp precision is
filesystem-dependent. No provider-account identity is inferred from filesystem
identity.
The attached root additionally requires a positive creation timestamp
(`birthtimeNs`). Device/inode alone is insufficient because deletion/recreation
can recycle an inode. A missing creation identity fails closed and old saved
records without it require explicit reselection. Mutable `ctime` is not used as
the persistent creation discriminator.

## Validation

Focused command: `node --test --test-concurrency=1 test/v2-collector-isolation.test.js`.
It covers the original exploit, directory swap before/after open, swap during a
pending read, swap-and-restore, file replacement/final links, nested links,
hardlinks, prefix collisions, duplicate/overlapping Home validation, whole-pass
rollback, baseline rejection, watcher-driven rejection, two-account restart
recovery, missing identities and adopted-file safety. All data is synthetic.

The first fresh collector review found no additional cross-attribution escape,
but identified a Medium availability regression: complete tree validation around
every directory produced 21,112 `lstat` calls at 100 directories and 183,312 at
300. It also reproduced starvation under ordinary appends. The fix now validates
only the relevant directory branch at enumeration boundaries and allows live
appends to an unchanged file identity. A deterministic operation-count regression
bounds a 100-directory scan, and another appends during every file read while
asserting progress (101 tokens), eventual exact total (200), and no duplicates.

The next independent review identified two further gaps, now covered by fixes
and deterministic regressions: a real Home B directory could replace A before
the first per-pass snapshot, and a file could grow during a read then shrink back
to its discovery size while committing a cursor past EOF. The persisted attach
identity now rejects the first case before collection or quota input pinning.
Per-file high-water sizes include every observed size and successfully read byte
range; later shrinkage rejects the entire pass, including staged events/cursors.
Tests cover replacement before reconciliation and after restart, restoration of
the original directory, legacy explicit reselection, and both post-read and
pre-commit truncation. No quota isolation architecture was redesigned.

A subsequent fresh review reproduced inode reuse in a real synthetic directory:
the first deletion/recreation reused its inode, admitting 777 tokens and passing
quota preflight. The persistent identity now includes creation time. A replay
against the fix confirms real inode reuse but rejects both collector and quota,
with zero attributed tokens. Deterministic tests also model equal dev/inode with
a changed generation, missing generation on old records, and unavailable birth
identity. Normal Home contents may change without changing its creation identity.

Previously recorded Low limitation, now explicitly accepted by the product
contract: collector reads/enumeration can update filesystem access
times (`atime`). An independently aged synthetic file and sessions directory
both exhibited this; contents and modification times were unchanged. Do not
claim byte preservation proves all-metadata equality. The quota runner's enforced
read-only mount/inventory tests are separate and continue to assert metadata
preservation. The current product Canary excludes normal atime updates while
still requiring unchanged contents, mtime and ctime.

Current automated results (fresh runs after the generation fix):

| Check | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| npm test | 316 | 316 | 0 | 0 |
| V1 | 68 | 68 | 0 | 0 |
| V2 | 248 | 248 | 0 | 0 |
| Node 24.15.0 V2 | 248 | 248 | 0 | 0 |
| Collector focused | 40 | 40 | 0 | 0 |
| Portable quota focused | 7 | 7 | 0 | 0 |
| Enforced namespace quota | 36 | 36 | 0 | 0 |
| Native Codex fixture | 4 | 4 | 0 | 0 |
| npm Codex fixture | 4 | 4 | 0 | 0 |

These are overlapping suites, not additive distinct-test counts. JavaScript
syntax: 76 files. Installer shell syntax, staged/unstaged diff checks: PASS.
Production dependency audit: 0 vulnerabilities. The native Codex tests use
synthetic inputs and are not authenticated real-user quota proof.

A new fresh independent review is required. Both direct creation and a fresh
child creation attempt from the previous reviewer failed with
`agent thread limit reached`. No old review or alternative CLI was substituted.
The latest completed independent
review was `gpt-6-astra` / `high`: C0/H1/M0/L1, before the generation fix above.
That High is fixed and reproduced as rejected by the main agent, but this is not
a substitute for a new independent C/H/M-zero review of the final candidate.
Previous 275-test and earlier quota review results are not proof of this candidate.
Real authenticated WSL Canary has not run and remains gated on independent
review C/H/M = 0. No real user Home has been selected or auto-discovered here.

## Handoff gate

**NOT READY:** start a new Codex session in this same preserved working tree and
request a fresh-context, review-only `gpt-6-astra` / `high` subagent. It must
inspect the final diff/untracked source and tests, not reuse this report as proof
of correctness. Require C0/H0/M0 before WSL detection or real Canary. The Low
collector access-time limitation remains recorded. No commit/push/release/deploy
has been performed. WSL detection and authenticated Canary: **NOT RUN**, because
the required final independent review could not be created.

최종 수정본은 전체 316/316, V1 68/68, V2 및 Node 24.15 V2 각각 248/248,
collector 40/40, quota 강제 격리 36/36을 통과했습니다. 실제 inode 재사용
재현도 수정 후 collector·quota 모두 거부하며 잘못 귀속된 토큰은 0입니다.
그러나 새 리뷰어 생성이 세션 스레드 한도로 두 번 실패했습니다. 같은 작업
트리를 보존한 새 Codex 세션에서 독립 리뷰부터 이어가야 합니다. 기존 리뷰를
통과로 재사용하지 않았고 WSL Canary·commit·push·배포도 하지 않았습니다.
