# Existing-Home quota isolation — unreleased candidate

No release, production deployment, main merge or tag is authorized for this stage.
The real authenticated WSL Canary is still required. Fixture success must not be
reported as actual provider quota success.

## Source audit

Installed CLI: **0.153.4**, peeled upstream commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`. Latest audited upstream HEAD:
`6af345407d9c2a568da9d01b6c4b81a9e61495c0`. The relevant startup writes remain in
the latest source. Source checkout used only for audit:
`/tmp/codex-meter-upstream-audit.gdv0FP/source`.

| Category | Source / condition | Treatment |
| --- | --- | --- |
| State SQLite, log SQLite, recovery backups | [app-server startup](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/lib.rs#L607), `state/src/runtime.rs`, `state/src/runtime/recovery.rs` | `CODEX_SQLITE_HOME` and explicit `-c sqlite_home=...` point to private scratch. Explicit config wins over environment. |
| Log files | [core config resolution](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/config/mod.rs#L3948) | Public `-c log_dir=...` points to scratch. |
| `installation_id` | [resolve_installation_id](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/installation_id.rs#L19): create root, open read/write/create, lock, chmod to 0644, generate/write/truncate/sync when absent or invalid | No public path override found. Original file is not opened by Meter or copied; Codex creates its own disposable identifier in the private virtual Home. |
| `tmp/arg0` | [prepare_path_entry_for_codex_aliases](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/arg0/src/lib.rs#L336): mkdir/chmod, stale cleanup, lock, helper links or Windows batch files | Private virtual Home; no original launcher changes. No reliance on debug build behavior. |
| Skills | [HostSkillsService](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/ext/skills/src/host_service.rs#L115), `skills/src/lib.rs:77-100`: install/replace system skills | Public `skills.bundled.enabled=false`; original skills not exposed. |
| Plugins / cache | [startup tasks](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core-plugins/src/manager.rs#L2735): Git sync, upgrades, extraction, cache removal, remote catalog cache | Public `features.plugins=false`; original plugin/cache trees not exposed. |
| Models cache | `app-server/src/models_refresh_worker.rs:45-61`, `models-manager/src/cache.rs:227-232`: immediate online refresh can write `models_cache.json` | Any new cache is confined to the private virtual Home. |
| Rollout maintenance / sessions / `.tmp` | [local thread store startup](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/thread_manager.rs#L380), `rollout/src/compression.rs:259-294,345-379,673`: optional startup migration/compression can rewrite/remove rollouts | Both `features.background_paginated_rollout_migration` and `features.local_thread_store_compression` explicitly false. Original history/sessions not exposed or copied. No thread/history RPCs. |
| OTel startup | `app-server/src/turn_cost_worker.rs:101-114,205`: optional startup auth/network worker | Public `otel.exporter="none"`, `otel.metrics_exporter="none"`. |
| Remote control / sockets / locks | `app-server/src/lib.rs:600-605`, `app-server-transport/src/transport/remote_control/websocket.rs:485-495,608-641`: socket lock only for Unix transport; persisted enrollment resolution can run after initialize | Stdio only; fresh scratch SQLite has no old enrollment. No internal disable environment flag is used. |
| Auth refresh persistence | [quota RPC](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/account_processor.rs#L1131), `login/src/auth/manager.rs:2345-2361,3012-3026`, `login/src/auth/storage.rs:206-224` | Codex resolves its own auth. The original auth file is mounted read-only; no Meter parsing, extraction, copying or hashing. Failed refresh persistence cannot retry unprotected. |
| Default-config fallback | [App Server configuration](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/lib.rs#L531), `cli/src/main.rs:555-556` | Public production `app-server --strict-config` is mandatory for existing Homes. Malformed config and inaccessible required resources must fail rather than silently drop endpoint/workspace policy. |

`account/read {refreshToken:false}` is not a global no-refresh option: rate-limit
reads can proactively refresh. Read-only file protection does not mean remote
token rotation cannot be attempted by Codex. OS keyring/service availability is
not preserved by this restricted adapter. Local TOML auth-store policies other
than `file` are rejected before starting Codex, rather than allowing native
`auto` storage to fall back from a keyring account to a stale file account.
The TOML check is bounded, read-only and memory-only; it never reads `auth.json`.
TOML inputs sharing the pinned auth inode are rejected before content inspection.
After initialization, `config/read` and `configRequirements/read` must also
confirm a supported policy before account/quota RPCs. Managed policy can be
loaded during startup, so this second check does not claim to prevent Codex's
own startup authentication for loading cloud policy. Config responses are never
logged, persisted or sent to Meter Server. No store-to-file override is applied.

## Actual startup tracing

Real installed Codex was traced inside a disposable container, with synthetic
Homes only, no auth file, no real user environment and networking disabled.
The trace collected file syscall paths/flags, not read/write buffer contents.
With official SQLite/log redirects and the background feature overrides above:

- `initialize` succeeded and `account/read` returned no authenticated account.
- `account/rateLimits/read` correctly failed for the unauthenticated fixture.
- `installation_id`: `open` with write/create flags, both existing and absent cases.
- `tmp/arg0`: mkdir, chmod, writable lock open, symlink creation and unlink cleanup.
- Without isolation, the originally absent installation ID and temp directory
  appeared in the fixture. This is direct runtime evidence, not a code-only claim.

Trace driver: `/tmp/codex-meter-upstream-audit.gdv0FP/trace-startup.mjs`.

## Runner boundary

`ExistingHomeQuotaRunner` uses Bubblewrap on Linux, including WSL when its kernel
permits the required namespaces. Bubblewrap 0.8.0 was used in enforcement fixtures.
There is no direct-execution fallback. Missing dependencies, failed setup, unsafe
paths and unsupported platforms yield local `write_isolation_failed`.

The child sees the **same CODEX_HOME pathname**, backed by a private tmpfs, not the
user's directory. Only selected auth/config regular files are bound read-only
using pinned FDs; a shared config link keeps its link and protected target path.
Ancestor symlinks in that external target are rejected. Auth symlinks are rejected.
Non-normalized config-link routes (for example a required directory followed by
`/../`) are rejected rather than recreated as broken links or silently replaced
by default config. Quota sync preflight also uses a no-follow pinned walk, not
the general attach/collector canonicalizer.
Even config-link inspection runs through a read-only mount: an ordinary `readlink`
can update symlink access time. A failing-before-fix real-Codex regression ages
the fixture link, then verifies unchanged atime/mtime/ctime across the probe.
Other existing Home contents are neither copied nor exposed to the probe.
Configurations requiring additional external resources may be unavailable;
the runner does not silently load default config after a dangling selected link.
The public `--strict-config` flag also prevents Codex's own fallback to defaults
after configuration errors. Native tests require invalid syntax and a missing
instructions-file resource to fail before initialization, without Home mutation.

The Codex filesystem view exposes system runtimes, exact required executable/package,
selected auth/config and scratch. It does not bind the host root or unrelated
user directories. Source FDs are closed before Codex runs. Environment credentials,
Node injection options and keyring service endpoints are not inherited.
Literal executable/PATH resolution runs a fixed `/usr/bin/realpath` metadata
utility in a separate read-only host view, with bounded output and no inherited
credentials. It does not enumerate Homes or open auth/session contents. This
protects launcher-symlink atime, including links traversing back into the selected
Home. Only this metadata utility sees the read-only host view; it is never used
for Codex execution. Resolved executable/package inputs are then pinned without
following ancestors and mounted read-only; overlaps with the selected Home fail
closed.

SQLite/logs and other new runtime data are private. Host scratch directories are
0700 random directories inside the reserved Meter-owned
`/tmp/codex-meter-quota-runtime-<uid>` namespace. This root must be private, owned
and marked; pre-existing unmarked directories and a symlinked `/tmp` are rejected.
Existing Home attachment rejects overlap with this namespace, including canonical
aliases. External config sources cannot reside there either. The janitor never
scans global `/tmp` or deletes old flat scratch paths: another CLI may have adopted
one after the Agent captured its exclusions. A regression actually attaches such
a Home and then runs cleanup with the stale exclusion snapshot.
Each child directory contains only a nonsecret ownership marker; runtime
contents exist only in private tmpfs. Cleanup uses pinned-directory access to
remove that marker and nonrecursive `rmdir`, never recursive deletion of a
selected Home. Parent death terminates the sandbox/PID namespace; a bounded-age,
bounded-entry janitor removes only owned, marked, otherwise-empty stale directories
with dead owner PIDs. Selected, unmarked, live and nonempty directories remain.
The protection set includes all configured and retained local Home selections,
plus this probe's external config source. Rejected nonempty stale directories
are inspected through read-only mounts and ownership markers with `O_NOATIME`,
so cleanup cannot change source access times merely while deciding to skip them.

Default and Meter-managed isolated quota retain their existing execution path.
Codex system configuration/requirements/legacy managed configuration files are
pinned and mounted read-only at their original `/etc/codex` paths. Unsupported
system-file symlinks fail closed; present policy is never silently dropped.
Official nested and sibling npm platform packages are mounted individually;
the runner does not expose an entire user prefix to resolve dependencies.
macOS/Windows explicitly fail closed until their native isolation adapters are
verified. This is a capability limitation, not permission to write to those Homes.

For protocol compatibility, precise `write_isolation_failed` is stored in Agent
local quota diagnostics. Existing Server quota enums receive the compatible
`app_server_unavailable`; the profile remains quota-unavailable, not offline due
to an invalid HTTP payload. No source/scratch paths are included in either report.

## Verification commands

Portable fail-closed tests: `node --test test/v2-quota-isolation.test.js`.
Mandatory-enforcement fixtures: `node --test tools/quota-isolation/verify.mjs`.
This command requires the supplied `tools/quota-isolation/fixtures/system` to be
mounted read-only at `/etc/codex` in the disposable container, plus
`CODEX_METER_FIXTURE_SYSTEM_CONFIG=1`. Do not use a real system configuration for
the fixture run. Missing the fixture is a test failure, not a skip.
Real CLI synthetic-Home fixtures: set `CODEX_METER_TEST_CODEX` to an explicitly
provided executable and run `node --test tools/quota-isolation/native.mjs`.
The latter does not log in and cannot prove actual provider quota availability.

On this host, ordinary nonprivileged user namespace creation is denied. Successful
enforcement tests run in a separate disposable container, with its own mount/PID
namespaces, no networking, no real Home mounts and no production data. The test
container grants SYS_ADMIN for namespace creation and disables its own seccomp/
AppArmor profile; host security settings are unchanged. Production Agent execution
does not create privileged containers or request elevated permissions.

The enforcement suite must return valid quota from its fake App Server as well
as unchanged source inventories. Unsupported isolation is a **test failure**,
not a successful alternative. A negative control removes isolation and verifies
that the same inventory equality assertion fails after a forbidden write.

## Current validation snapshot — 2026-09-06

| Command / fixture | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| `npm test` (host Node 22.22.3) | 275 | 275 | 0 | 0 |
| `npm run test:v1` | 68 | 68 | 0 | 0 |
| `npm run test:v2` | 207 | 207 | 0 | 0 |
| Node 24.15.0, V2 | 207 | 207 | 0 | 0 |
| Mandatory namespace enforcement | 33 | 33 | 0 | 0 |
| Real Codex native executable, synthetic Home | 4 | 4 | 0 | 0 |
| Real Codex npm launcher, synthetic Home | 4 | 4 | 0 | 0 |

The npm/V1/V2 rows overlap and are not additive. The real CLI rows verify startup
and unauthenticated RPC behavior; only the fake App Server fixtures return quota.
No authenticated provider response is claimed for this candidate.

Syntax: 73 JavaScript files PASS. Unix installer syntax and both Git diff checks
PASS. Production dependency audit: zero vulnerabilities.
Logs: `/tmp/codex-meter-quota-final-{full,v1,v2,node24-v2}.log`,
`/tmp/codex-meter-quota-{enforcement,native,real-npm}.log`.

Independent reviews identified and prompted fixes for symlink-atime reads in
preflight and launcher resolution, non-normalized config links becoming missing
config, omitted system config layers, and npm sibling dependency isolation.
The system-policy/npm fixtures failed before their fixes (20 pass / 2 fail),
then passed with enforcement intact. Original Home files/credentials were not
used for these reproductions.

## Previous independent review — collector integration finding

Fresh-context `gpt-6-astra`, reasoning `high`, reviewed actual source/diff and ran
the 34 portable/existing integration tests and 33 mandatory enforcement tests.
Final counts: **Critical 0 / High 0 / Medium 1 / Low 0**. No confirmed C/H/M
finding was identified in quota startup isolation itself; this is **not** a
PASS for the broader candidate.

The confirmed Medium is in existing usage collection, separate from the quota
runner: after `discoverExistingRollouts` validates Home A's session roots, a
concurrent writer can rename `A/sessions` and replace it with a link to Home B
before `discovery.js` opens that pathname. `reader.js` subsequently reopens
pathnames too. The reviewer baselined empty A, performed that one-way replacement
at the validation/use boundary and observed B's synthetic **777 tokens** in A's
`personal` outbox. No ABA restoration or real Home was needed. Stable replacements
present before validation are already rejected, but that does not close the race.

Closing this separate collector boundary requires pinned, no-follow directory
and file access maintained through discovery and reading. Another path recheck
alone is insufficient. A subsequent collector fix and its current validation
are tracked in [collector isolation](v2-collector-isolation.md).
Actual-Home Canary remains gated on independently reviewing that fix.

Linux x64 SEA packaging also succeeded in the disposable Node 24.15 container;
the built executable reports version 2.1.3. This is a local packaging check, not
a release asset. Native macOS/Windows packaging was not performed.

No candidate commit/push, main merge, tag, release or production deployment.
Real authenticated WSL Canary remains required before release validation.
