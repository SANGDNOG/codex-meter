# Quota handoff review — 2026-09-06

Result: **NOT READY — supplied patch not adopted**.

The user supplied four quota implementation/test files in a ZIP. They were
extracted to a separate temporary review directory and compared with the server
candidate. The ZIP and candidate implementation remain unchanged. No real Homes,
credentials, production resources, service settings, commits or pushes were used.

## Independent review

Fresh-context, read-only `gpt-6-astra`, reasoning `high`, reviewed the supplied
four files and their connection to the current candidate. This is a review of
the proposed quota patch, not a new approval of the entire candidate.

Findings: **Critical 0 / High 2 / Medium 2 / Low 0**.

- **High — incomplete filesystem boundary (`quota-isolation.js`, `SETUP`).**
  Only the selected Home, scratch and particular config-file paths are mounted.
  Other host paths retain ordinary same-user access after capability removal.
  In particular, a writable hard-link alias can modify a protected auth/config
  inode through a path other than its read-only mount. Configuration-launched
  helpers are not confined to disposable writes. This is a source-level finding;
  a namespace-capable hostile-child integration was not executed here.
- **High — false-green enforcement tests (`v2-quota-isolation.test.js`).**
  Any `app_server_unavailable` is accepted by the purported successful isolation
  test, including setup failures and failed assertions in the fixture child.
  The timeout case does not require the hanging child to start or actually time
  out. Capability-unavailable and successful-enforcement tests must be separate.
- **Medium — parent-death lifecycle (`app-server.js`, `quota-isolation.js`).**
  `--kill-child` ties the inner child to `unshare`, not `unshare` to the Agent.
  Unexpected Agent termination can bypass `close()` and leave the process tree
  and scratch directory behind. Enforced parent-death supervision and safe stale
  scratch handling need explicit verification. This is source-level evidence.
- **Medium — shared-config ancestor substitution (`prepareQuotaIsolation`).**
  `realpath()` followed by absolute `open(O_NOFOLLOW)` protects only the final
  component. A substituted ancestor can select another regular config file.
  Descriptor-relative no-follow traversal (or an equivalent atomic facility)
  is required before claiming that the intended target is pinned.

## Main-agent reproduction

Only disposable source copies and fixtures were used:

1. Original supplied tests: **4 total / 4 passed / 0 failed / 0 skipped**, despite
   this host refusing nonprivileged namespace creation.
2. Strengthen only the temporary tests to require an available quota result and
   `app_server_timeout`: **4 total / 2 passed / 2 failed / 0 skipped**. Actual
   results were `unavailable` and `app_server_unavailable`; this demonstrates why
   the original green result is not proof of isolation or timeout execution.
3. Inject ancestor replacement between shared-config resolution and opening:
   the helper accepted and pinned the other fixture's config. Confirmed by FD
   path metadata, without reading credential contents or running Codex.

These diagnostic results are not the candidate's full regression results. The
previous 255/255 candidate result does not validate this proposed quota patch.

## Integration constraints

- The patch is Linux-only and unconditionally rejects darwin/win32 for existing
  quota. Default/isolated paths are not changed by that switch, but existing-mode
  quota parity across supported installers is not established.
- Nonprivileged namespace creation is unavailable on this server. No kernel,
  AppArmor, container privilege or security settings were changed to bypass it.
- Masking the selected Home also hides its original packages/runtime files; a
  Codex installation or required config resource inside it requires further
  compatibility assessment rather than assuming auth/config alone suffice.
- No unprotected retry should be introduced. No auth-file copying, Home chmod,
  shared-config rewriting or provider identity inference is an acceptable fix.

The remaining work is a scoped execution-isolation design, not simply merging
these four files or adjusting a SQLite path. Platform coverage and a capable
integration runner must be decided before final validation can be claimed.

## Native Codex sandbox feasibility follow-up

A separate fresh-context `gpt-6-astra` / `high` read-only design assessment
considered using Codex's platform sandbox instead of adopting the supplied
Linux-only namespace helper. This was **not** an implementation review or PASS.

The main agent invoked the installed sandbox CLI using only newly created,
empty temporary Homes and `/bin/true`. With a custom read-only filesystem
permission profile and networking enabled, startup failed with:

```text
bwrap: setting up uid map: Permission denied
```

Thus the native sandbox is not an independently verified escape from this
host's namespace restriction. No host security settings were changed. This
does not establish that native sandbox execution is unavailable on other hosts
or that macOS/Windows support is impossible.

Design issues still requiring implementation and platform evidence:

- A separate clean bootstrap Home is necessary to keep outer CLI startup from
  loading selected configuration before the child boundary exists.
- Disposable Home plus auth/config symlinks is not a complete filesystem
  boundary, does not establish keyring identity compatibility, and may alter
  configuration resource resolution.
- `account/read` with `refreshToken: false` does not guarantee that subsequent
  runtime or credential operations never write. Failed protected refresh must
  not retry against writable original credentials.
- All scratch writes, protected aliases, process-tree lifetime and cleanup need
  enforcement tests that fail when enforcement is not actually exercised.
- An already-running App Server is not a safe substitute without an explicit,
  verified association to the selected Home; a default socket is insufficient.

No real user Home, authentication contents or provider quota was accessed in
these probes. No quota implementation was changed or approved by this follow-up.
