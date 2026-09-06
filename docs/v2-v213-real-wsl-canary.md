# V2.1.3 — Real WSL Canary and final regression

**READY FOR V2.1.3 RELEASE DECISION**

Completed on the personal PC, 2026-09-06: Ubuntu WSL2, Node 24.15.0,
Codex CLI 0.153.4. This is actual authenticated Canary evidence for the current
source snapshot. Candidate application code was not changed.

The user explicitly authorized resolving the selected environment through the
`procodex` launcher. No other real Homes were discovered. A separate loopback
Canary Server, fresh one-time enrollment, Device, Account/Profile, Group and
Agent database were used. Existing production services were not contacted.
Local HTTP exercised the Server's trusted HTTPS-proxy header path.

## Real Canary results

| Check | Result | Evidence |
| --- | --- | --- |
| Existing Home attach | PASS | Exact launcher-selected Home attached to the intended Profile |
| Existing usage baseline | PASS | Six existing files, 4,105,538 bytes baselined at EOF; zero old events emitted |
| Actual new usage | PASS | Ongoing user-requested procodex activity produced two initial new events / 142,347 tokens |
| Account/Profile/Device/Group attribution | PASS | All uploaded events matched the intended isolated identities; another Account remained zero |
| Other Home not tracked | PASS | One selected collector; watchers restricted to that Home; legacy fallback disabled; an unselected synthetic control Home's 999,999-token event was excluded |
| Actual authenticated `account/read` | PASS | Account present, authenticated response; credentials and account details not retained |
| Actual authenticated `account/rateLimits/read` | PASS | Real provider windows received and stored under the selected Account |
| Selected Home only quota probe | PASS | One profile reporter, no legacy reporter; actual RPC client asserted the selected Home and protected runner |
| Adopted Home integrity | PASS | Successful authenticated quota observation had identical before/after inventories; details below |
| Agent restart | PASS | Runtime/database reopen and a separate actual CLI process startup, healthy sync and graceful exit preserved history and cursors |
| Stop tracking | PASS | Zero collectors, watchers and quota reporters; history/cursors unchanged |
| Real activity while stopped | PASS | A subsequent nonzero provider record was observed while Meter stayed at four events / 288,802 tokens |
| Re-add | PASS | Fresh local selection and EOF baseline excluded stopped-period activity and retained prior history and cursor generations |
| New usage after re-add | PASS | Subsequent actual activity raised the observed cumulative total to six events / 440,193 tokens |

The stopped-period witness contained 73,786 `last_token_usage` tokens; this is
a raw provider-record witness, not a claim about a separately deduplicated total.
After re-add, 12 old/new generation cursors were retained. The separate Agent
process check preserved all 12 and the existing Server history.

The unselected Home control was synthetic. Other real Homes were not accessed;
no second authenticated account was exercised. Actual usage and authenticated
quota came from the selected real Home, not from fixtures.

## Actual provider quota

Successful guarded observation: `2026-09-06T13:35:03.979Z`, plan `pro`.

| Provider identifier | Window | Used | Reset (UTC) |
| --- | --- | ---: | --- |
| `codex` | Weekly / 10,080 minutes | 46% | 2026-09-07 04:11:27 |
| `codex_bengalfox` | 5H / 300 minutes | 0% | 2026-09-06 18:34:57 |
| `codex_bengalfox` | Weekly / 10,080 minutes | 0% | 2026-09-13 13:34:57 |

All three windows appeared in the Canary Server with status `available` and
correct Account attribution. The provider identifiers are retained verbatim;
no meaning is inferred for an undocumented identifier.

## Integrity and execution observations

The successful authenticated probe compared 8,155 selected-Home inventory entries
and the selected external shared-config target. Inventory checks included entry
presence, type/mode, device/inode, size and nanosecond mtime/ctime, plus content
digests for config and sessions. Auth contents were never read, parsed, copied
or hashed by the Canary observer; auth integrity used metadata. The protected
Codex child performed its own authentication. All compared values were unchanged.
Normal OS-maintained read atime changes were excluded as agreed.

Guarded attach, collection, Runtime restart, Stop tracking, Re-add and one actual
Agent-process interval also had unchanged inventories. Earlier intervals that
overlapped ongoing Codex session/SQLite activity were inconclusive for writer
attribution and were not counted as PASS or treated as Meter bugs. A subsequent
quiet interval established both successful authenticated quota and unchanged
Home inventory together. One intervening quota attempt returned
`app_server_unavailable`; the final complete observation succeeded.

Bubblewrap was initially absent. The Ubuntu package `bubblewrap` 0.6.1 was
installed through the PC's WSL root execution facility. Namespace execution and
the actual candidate runner then worked as the normal user. No security settings
were relaxed and no unprotected quota fallback was used. No application
correctness bug or new filesystem-hardening task was established.

## Final regression

Fresh runs after the successful authenticated Canary, using the absolute Node
24.15.0 executable and the unchanged commands from `package.json`:

| Check | Total | Passed | Failed | Cancelled | Skipped |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full test command | 319 | 319 | 0 | 0 | 0 |
| V1 test command | 68 | 68 | 0 | 0 | 0 |
| V2 test command, Node 24.15.0 | 251 | 251 | 0 | 0 | 0 |

These overlap and must not be summed. JavaScript syntax: 76 files PASS. Unix
installer syntax: PASS. Production dependency audit: zero vulnerabilities.

An initial invocation through `npm` selected Node 21.7.3 for its child commands
and failed to load `node:sqlite`. Those invalid-runtime attempts were not counted
as valid regression runs. The complete commands above were rerun with Node
24.15.0 explicitly selected, without changing global settings or candidate code.
This checkout is a source snapshot without `.git`; Git diff checks are unavailable.

Local evidence is retained in `/tmp/codex-meter-real-wsl-GHyxpR/`, including
`report.json`, `process-restart-result.json`, `stopped-usage-witness.json`,
`quota-result.json`, `quota-attempts.jsonl`, `final24-full.log`, `final24-v1.log`,
`final24-v2.log` and `final-audit.json`. Actual Home paths and credentials are
omitted from this report. Canary services were stopped; local state is preserved.

No commit, push, merge, tag, release or production deployment was performed.
