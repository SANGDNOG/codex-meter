# OpenCodex setup wizard validation — 2026-09-08

Base: `0b0e34e63ec4cbbc81c86874cc4efa021be2efc8` on
`feature/v2.2-opencodex-hub`. This report describes an **uncommitted wizard
working tree**, not the original checkpoint. No commit/push/deployment or
existing Canary infrastructure changes were made for this task.

## UX Design

Canonical command: `codex-meter-agent opencodex setup`.
Enrollment and pending Hub intent are checked first. No pending Profile means
no credential prompt. Already-selected Profiles are reported configured only
after local connection metadata, matching connection IDs and credential reference
validate; missing/corrupt/unusable configuration reports actionable recovery.
First-time setup asks for the Hub origin, a credential, and explicit account
selection; multiple pending Profiles are selected by readable name/number first.
An existing valid connection is reused without rewriting it. A failed/missing
connection with existing selections is not destructively reconnected.
The existing main-slot warning and explicit confirmation remain.

## Files Changed

- Agent: `v2/agent/cli.js`, `v2/agent/opencodex.js`, new
  `v2/agent/setup-terminal.js`.
- Web: `v2/web/app.js`.
- Tests: new `test/v2-opencodex-setup.test.js`, additions to
  `test/v2-v21-onboarding-ux.test.js`.
- Docs: `README.md`, `README.ko.md`, `docs/v2-opencodex-hub.md`, this report.

## Security Boundary

The POSIX prompt uses a muted readline output, no terminal echo/history, and
restores raw mode on completion, Ctrl-C, EOF, SIGTERM and input error. Sanitizing
error listeners remain through output flush and its next-tick error events. The wizard
passes the result to the existing `connectHub` stdin flow: Agent-local 0600
credential storage, separate connection metadata, no credential in argv, SQLite
or Server payload. Credential-input/auth failures leave no newly generated secret.
Windows uses an explicit environment-variable reference, not a new credential
file. Background Agent access to that variable remains the operator's concern.
Invalid URLs fail before asking for credentials. No Hub/credential discovery.
No terminal means no wizard selection; existing manual commands are printed.

## Backward Compatibility

`opencodex connect` and `profile attach-opencodex` retain their behavior and
default output. The wizard reuses both implementations; attach additionally
returns a sanitized Profile name and can suppress its legacy completion line.
`HubAdapter` is unchanged and observes the new selection at the normal eligible
heartbeat; no service restart is required. A stopped Agent must still be started
normally. No Server/protocol/API/snapshot/quota/Native collector/migration or
dependency change. Existing migration files and installers are untouched.

## Web Onboarding

Hub Device creation/enrollment and pending Hub Profile views now show:
install/enroll the Agent, then `codex-meter-agent opencodex setup`.
English/Korean guidance is covered by DOM tests. Advanced connect/attach and
secret-file instructions remain in manual documentation, not the default Web UX.
Native onboarding and measurement behavior remain covered by existing tests.

## Tests Added

49 Agent/terminal tests and 2 Web tests cover pending/enrollment gates, URL
rules, hidden input, 0600 ownership, cleanup, existing connection reuse/failure,
explicit one-account selection, multiple Profiles, main confirmation, identity
conflicts, Windows env references, non-TTY/manual guidance, old commands,
unchanged wire privacy, and heartbeat activation without restart.
A complete terminal-stream fixture uses the actual production question reader
for URL, hidden credential, and account; no injected question functions.
Existing Node readline error propagation was caught during implementation and
the new terminal helper now sanitizes that path; the regression passes.
Review also identified delayed stream errors, false configured state with missing
connection metadata, and overly broad help interception. All were fixed with
regressions; only `opencodex setup --help` uses the new help path.

## Full Test Results

| Scope | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| `npm test` | 429 | 429 | 0 | 0 |
| `npm run test:v1` | 68 | 68 | 0 | 0 |
| Node 24.15.0 `npm run test:v2` | 361 | 361 | 0 | 0 |
| Wizard + existing Hub + Web focused | 130 | 130 | 0 | 0 |
| Wizard only | 49 | 49 | 0 | 0 |

These scopes overlap; do not add their totals. All runs have zero cancellations.
Syntax: 82 JavaScript files PASS. Installer `sh -n`: PASS. Both diff whitespace
checks PASS. `npm audit --omit=dev`: 0 vulnerabilities.
Privacy-pattern check: no live-key/JWT/operator-path flags in changed files;
synthetic sentinel tests separately check that credentials/other-account data
do not reach output or Server reports. Pattern scans alone are not proof of privacy.

Manual Linux PTY smoke (synthetic input, no real Hub): visible URL prompt → hidden
credential (no echo observed) → visible account prompt → PASS. This does not claim
a real provider connection, macOS/Windows terminal run, or authenticated Canary.
Independent UX review: `gpt-5.6-luna`, reasoning `xhigh`; final C0/H0/M0/L0,
PASS after source re-review of the three fixes. Reviewer independently reran
the wizard suite: 49/49 PASS. No reviewer edits or production access.

Logs: `/tmp/codex-meter-wizard-final-{full,node24-v2,focused,v1,syntax,audit}.log`;
wizard-only log: `/tmp/codex-meter-wizard-review-fixes.log`.

## Remaining Real Canary Delta

The owner reports REAL OPENCODEX CANARY PASS for base checkpoint `0b0e34e`.
That does **not** validate this newer wizard working tree.
Use a wizard-capable candidate Agent in an approved isolated test setup to check
actual enrollment → hidden credential input → selected-account setup → automatic
usage/quota sync; then verify connection reuse, cancellation and no unexpected
credential output. Compare the same selected account/ranges/quota using the
existing Canary acceptance checks. Do not change or delete current Canary
infrastructure or production as part of this UX task.
