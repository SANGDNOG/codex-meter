# Existing-environment candidate validation — 2026-09-06

Status: **RELEASE GATES PASS**; actual WSL results are recorded in
[the final Canary report](v2-v213-real-wsl-canary.md). Earlier pending statuses
below are historical. Final product-scope review PASS:
fresh Astra high, in-scope C/H/M/L all 0. Current machine is ordinary Ubuntu, not WSL.
The [M1 product-validation report](v2-v213-product-validation.md) records the
latest candidate: 319/319 full, V1 68/68, V2 and Node 24.15 V2 251/251, zero
failures/skips. Previous reviewer
thread-capacity failures and earlier test snapshots below are historical.
A new protected quota runner is implemented; current
quota evidence is recorded in [quota isolation](v2-quota-isolation.md). The
discovery and earlier candidate results below are historical snapshots, not
validation of the new quota implementation.

## Candidate

- Branch: `fix/v2.1-existing-codex-home`
- Candidate Agent version: `2.1.3`
- Base commit: `a1834ce7dba8ce490a86721b179d34f5f723254f` (not a candidate commit).
- No candidate commit or push. No main merge, tag, GitHub Release or production upgrade.
- Pre-existing uncommitted deletion/i18n/polling/connection repairs were preserved.
  Their starting snapshot is `/tmp/codex-meter-existing-baseline.SnjkaF/`.
- Published `v2-agent-2.1.0` and `v2-agent-2.1.1` were not modified.

## Previous discovery-candidate automated results (before quota isolation)

| Command | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Existing-environment + candidate discovery focused files | 29 | 29 | 0 | 0 |
| `npm test` | 265 | 265 | 0 | 0 |
| `npm run test:v1` | 68 | 68 | 0 | 0 |
| `npm run test:v2` | 197 | 197 | 0 | 0 |
| Node 24.15.0 Docker, V2 full suite | 197 | 197 | 0 | 0 |

Unique full-suite total: **265 passed, 0 failed, 0 skipped**. Repeated executions
and focused subsets are not added together as unique tests.

- Host Node: 22.22.3. Required-version validation: `node:24.15.0-bookworm-slim`.
- `npm run check:syntax`: PASS, 71 JavaScript files.
- `sh -n v2/install/install.sh`: PASS.
- `git diff --check` and `git diff --cached --check`: PASS.
- `npm audit --omit=dev`: 0 vulnerabilities; no dependency upgrades.
- Latest full/V1/V2/Node24 logs: `/tmp/codex-meter-local-discovery-{full,v1,v2,node24}.log`.

## User-invoked local candidate discovery

The user explicitly authorized replacing the earlier unconditional discovery ban
with **opt-in, local-only directory candidate search**. `profile attach-existing
--discover`, or `?` at the install/attach path prompt, lists bounded immediate
directory candidates in exact default locations or user-specified parent folders.
The background Agent never calls it. Candidate contents, credentials and launcher
commands are not inspected. The list is not persisted or sent to the Server.
Only a numbered selection invokes the existing validated attach/EOF-baseline flow.
Cancel and non-TTY paths leave assignment and baseline tables untouched.

Ten new regressions cover scope, no file-content opening, directory links,
bounds, literal shell characters, exact Profile mapping, cancellation/non-TTY,
post-display directory replacement, terminal routing and Windows case semantics.
Existing attribution, quota-fixture isolation and restart regressions also pass.
All discovery tests use disposable fixtures, not real user Home searches.
Native macOS/Windows execution and real-provider quota are not established by
the Linux/Node test results.

Independent discovery reviews (fresh-context `gpt-6-astra`, reasoning `high`)
identified two Medium issues, then one further Medium compatibility issue:

- Candidate path strings could follow a replacement symlink after the menu was
  displayed. A new failing-before-fix regression reproduces this. Discovery now
  retains canonical path + device/inode identity in memory and verifies them
  before attachment, before baseline and before selection commit. Manual alias
  attachment remains unchanged.
- Unix `/dev/tty` fallback sent questions to the terminal but menu inventory to
  stdout. The reviewer reproduced this with an actual temporary PTY. Interactive
  menus now use the same controlling terminal, with a regression using fake
  terminal streams and redirected output.
- Strict path comparison rejected Windows canonical case normalization.
  Comparisons now follow existing Windows case-insensitive canonical semantics,
  retaining inode/symlink checks. A temporary metadata simulation covers the full
  selection path; it is not a native Windows execution claim.

All commands above were rerun after these corrections. Final fresh-context
`gpt-6-astra` / `high` discovery review: **PASS, C0/H0/M0/L0**. The reviewer
independently inspected current source/diff and relevant baseline/runtime/installer
call sites, and executed 10/10 focused fixture tests. This approves only the local
discovery feature, not the known quota safety issue or the release. No quota
implementation, production state, commit or push was changed by this feature work.

## Deleted-device correction and multi-environment regression

The account device-row query and active device count now exclude removed devices.
The deletion regression failed before this correction and passed afterwards.
Historical events and bindings remain unchanged; account/group historical totals
survive reopening the Server database. A stopped binding on a non-removed device
remains visible but does not count as actively registered. HTTP coverage also
checks an archived account after its device is removed.

A new two-existing-home regression explicitly selects two local fixture Homes
for distinct Account Profiles. Results: first Home only = 25/0 tokens; both
attached = 32/9; after stopping the first and restarting Runtime = 32/18.
Five events are unique. Simulated quota values 11%/77% stay with their respective
Profiles, and only the remaining Home is probed after stop/restart. Home paths
are absent from wire payloads; fixture config/auth sentinels and directory
contents remain unchanged. These are automated fixtures, not actual provider
quota or actual laptop/WSL evidence. No production writes were performed.

## Covered behavior

The Web DOM + real local HTTP Server + actual enroll/attach CLI E2E creates a new
one-time enrollment, chooses Personal/existing, locally selects fixture cx1,
excludes its old 100 tokens, uploads its new 25 tokens, ignores cx2's 999 tokens,
and preserves measured history across Server database restart. Tokens are not
printed. This is an automated WSL-shaped Linux fixture, not an actual WSL test.

Other checks cover local-only path payloads, exact Profile mapping, zero Home B
filesystem calls/collectors/watchers/reporters, immutable config/auth/markers,
non-destructive stop/re-add, isolated/default/legacy regressions, 008→009 and
005→006 upgrades, EOF and attachment-generation cursors, persistent selection,
outbox retention, unsafe names/paths, canonical aliases and root/session links.

Local selection now publishes only baseline and local selection state; Runtime
alone activates assignments inside its existing serialized operations. An
in-flight quota observation cannot have its assignment changed by the attach
CLI. Canonical root replacement is rejected before activation, reapply,
collection and quota observation. Compatible Server snapshots have distinct
revision numbers, honor explicit stops, and advance on Agent upgrade.

Overview retains distinct provider quota buckets and labels tabs using the
provider identifier plus reset period. No quota or attribution formula changed.

## Independent review gate

The user authorized replacing the unavailable Luna review with Astra.
Fresh-context `gpt-6-astra`, reasoning `high`, independently reviewed the actual
candidate and returned C0/H0/M3/L0. All three Medium findings were reproduced
as failing regressions and corrected:

- Initial collection failure no longer terminates startup before communication
  and retries. All collectors settle before synchronization; healthy Homes keep
  collecting. Adopted canonical roots are checked before watcher registration,
  so a replaced root cannot redirect child watchers into another Home.
- Failed local selection activation at an already-applied revision is reported
  as a profile failure without emitting an invalid failed remote revision.
  Heartbeats remain accepted, and restoring the Home retries activation.
- Account archive transactionally disables its active bindings, closes periods
  through the existing trigger, and releases default slots. Unarchive does not
  implicitly resume tracking. Historical usage remains intact.

The then-current 255-test validation was rerun after these fixes. A second fresh-context
`gpt-6-astra` / `high` review independently inspected the updated diff and
returned **PASS: Critical 0 / High 0 / Medium 0 / Low 1**. It also freshly ran
69/69 tests across existing-environment, declarative-core, onboarding UX and
installers. Earlier review conclusions were not reused.

Low: `v2/web/app.js:113`, `profileRow`, displays a bare attach command although
standard macOS/Windows installs put the executable outside PATH. The installer
full-path fallback is usable. Recommended minimal follow-up: platform-specific
installed-path commands and custom-install guidance, never a selected Home path.
Native Windows/macOS execution was not performed. No reviewer file changes or
production access occurred. This previous approval predates local candidate
discovery and must not be reused as approval of that new implementation.

## Real Canary gate

The user supplied a redacted report from actual Ubuntu WSL2, Node 24.15.0 and
Codex CLI 0.153.4. This is laptop-reported evidence, not a Canary executed by
the server-side agent. The original candidate passed EOF baseline (five existing
files), real new usage, Account/Device/Group attribution, selected-only
collection/watchers, Agent/Server/database restart, stop/re-add and history
preservation. Reported stop-period usage of 345,226 tokens was excluded and
post-readd usage of 360,539 tokens was collected. Its full regression was 255/255.

**The real quota gate FAILED for the unmodified candidate.** With the adopted
Home mounted read-only, App Server failed before quota RPC completion. The report
confirmed SQLite startup failure plus write attempts on `installation_id` and
`tmp/arg0`. Read-only RPCs do not imply a filesystem-read-only App Server process.
The report did not establish an auth/config write attempt.

A laptop-only namespace workaround returned real quota. Initial success omitted
an external shared-config symlink target; a later version exposed that target
read-only and also returned quota once. A final additional protection change was
not revalidated. Four laptop-only quota implementation/test files are modified
or new. Their full source was subsequently supplied in a ZIP and reviewed in
temporary copies; it was not adopted into this server candidate. Their four tests
allow isolation-unavailable outcomes and are not proof of successful isolation.
The 255/255 result and prior review do not certify those laptop-only changes.
The independent supplied-patch review returned C0/H2/M2/L0; main-agent disposable
reproductions confirmed false-green tests and shared-config ancestor substitution.
See [quota handoff review](v2-quota-handoff-review.md) for evidence and limits.

Read-only server checks confirm the candidate directly spawns App Server with
the selected Home. Official location overrides cover SQLite, not a complete
no-write execution guarantee. This server's nonprivileged user/mount namespace
probe fails at UID mapping with `Operation not permitted`; kernel/security
settings have not been changed. No real Homes or credentials were accessed.

A temporary native Linux x64
installer + Chromium fixture script has been prepared at
`/tmp/codex-meter-existing-canary.mjs`; it uses a fresh local Server, new token,
two disposable homes, a mocked systemd registration and a fixture App Server.
It does not establish actual provider quota or actual WSL systemd behavior.

Next: resolve the reviewed quota isolation findings and platform scope;
preserve adopted-Home write isolation without relaxing privacy or silently running
unprotected; validate the resulting candidate, fresh independent review and real
selected-Home quota Canary. Only after all gates pass consider commit/push.
Release/merge/production changes still require separate user approval.
