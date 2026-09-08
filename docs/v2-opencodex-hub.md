# V2.2 candidate: Native onboarding and OpenCodex Hub

This is an unreleased feature branch. Do not point a stock V2.1.3 installer at it
and assume the resulting Agent contains these commands. No production change is
part of this work.

## Native existing environment

On the Device's web page, add an Account Profile using **Native Codex → Use an
existing Codex environment**. Once local selection is pending, run:

```sh
codex-meter-agent profile attach-existing
```

The bare command now opens the existing local candidate picker. `--discover`
still works. The search policy is unchanged: known local roots only, no launcher,
alias, auth or recursive discovery. Choose one candidate explicitly, or choose
`0` to enter a path. `--codex-home PATH` remains available. Without a TTY the
Agent prints the actual installed command, including its config argument; it
never selects a candidate automatically. Multiple pending profiles are selected
by readable name/number first.

All Codex clients using the selected CODEX_HOME are tracked, including Codex CLI
and Codex IDE extensions. They are not separate measurement sources. EOF
baselines, cursor/history semantics and adopted Home protection are unchanged.

## OpenCodex setup

Create a Meter Account Profile with **Measurement source → OpenCodex Hub**.
Add it to the Device representing the Hub Agent (not each client laptop).
Source type is fixed when creating a Profile; Native Profiles are not converted.
Only one reporter can be active for a Hub Profile.

After installing/enrolling a wizard-capable candidate Agent, run on its machine:

```sh
codex-meter-agent opencodex setup
```

The wizard checks enrollment and pending Hub Profiles before asking for a
credential. With no pending Profile, add one to this Device in the dashboard;
the wizard never creates Server Profiles. Already-configured Profiles do not
trigger reconnect. A valid existing Hub connection is reused; an invalid one is
not silently overwritten. Selected Profiles with missing/invalid local connection
metadata or an unavailable credential reference report actionable recovery, not
successful configuration. For a first connection, enter the Hub origin and:

- Linux/macOS: type the credential at the **hidden** prompt. It uses the existing
  stdin credential storage: an Agent-local owner-only 0600 file, separate from
  config, connection metadata and SQLite. Credential-input/auth failures do not leave a new
  credential file. Never put the credential in the command line.
- Windows: enter the name of an explicitly configured credential environment
  variable. The running/background Agent must receive that same variable. No new
  plaintext credential-file storage is introduced.

Choose a pending Meter Profile if there are several, then explicitly select one
Hub account even if only one is listed. `main` still needs explicit confirmation.
Completion shows the Meter Profile name; a running Agent picks it up on its next
eligible heartbeat without a service restart (up to the existing polling cadence).
If the Agent is not running, start it normally; the wizard does not install/start
services. No terminal means no interactive setup, secret guessing or automatic
account selection. It prints advanced/manual commands instead.

### Advanced/manual connection (backward compatible)

The existing commands remain available, with unchanged semantics. Provide the
Hub Management API credential explicitly:

```sh
codex-meter-agent opencodex connect --url https://your-hub.example --secret-file /your/private/credential-file
codex-meter-agent profile attach-opencodex
```

The URL must be an origin: HTTPS, or HTTP on a loopback host. URLs with embedded
credentials, query strings, fragments or path prefixes are rejected. Redirects
are not followed with credentials.

The secret file must be owned by the Agent user and have owner-only permissions
on Linux/macOS. `--secret-stdin` accepts a piped secret and writes a separate
owner-only local file; never put the secret in argv. `--secret-env VARIABLE_NAME`
references an explicitly supplied environment variable instead. The background
Agent service must have that environment variable too. Windows uses this
environment-reference option; this implementation does not claim POSIX mode bits
secure a Windows secret file. The connection is Agent-local, separate from
Profile bindings. Do not use the same file as the Agent config/database.

No OpenCodex private config/auth files are searched. The picker shows aliases,
plans and log labels locally; raw IDs and emails are not projected. Select one
account. For `main`, explicitly confirm the warning: it is the Hub's **main
slot**, not a permanent provider identity. Re-logging the main slot changes the
underlying account that the slot represents.

Native and Hub Profiles can coexist on a reporter. Hub Profiles do not create
Native collectors, watchers, launchers or quota App Servers. An enrolled
Hub-only reporter gets an empty applied Native configuration, preventing
legacy/default collection fallback.

### Existing connection recovery

If setup reports that existing configuration needs attention, do not re-enroll
or delete the Device. Restore the original Agent-local connection/credential
from your private backup, or restore its explicitly named environment variable.
No credential should be pasted into a report or sent to the Meter Server.
If intentionally replacing a Hub connection, stop its Hub bindings in the
dashboard and let the Agent apply the stop before using the advanced `opencodex
connect` command. Re-add the wanted Hub Profile and run `opencodex setup` again.
The wizard does not perform that destructive recovery automatically.

## Audited stock API contract

Audit: OpenCodex public main commit
`bba63222d3eeb5c8e397edae35798225e4fa1a6f`, package version `2.46.0`,
retrieved 2026-09-07. No OpenCodex source modification/fork is used.

- [Account DTO and route](https://github.com/lidge-jun/opencodex/blob/bba63222d3eeb5c8e397edae35798225e4fa1a6f/src/codex/auth-api.ts):
  `GET /api/codex-auth/accounts`; `accounts[].logLabel`, alias/plan for the local
  picker, `quota`, `needsReauth`, and refresh outcome. `id`/`email` never leave
  response processing. No `refresh=1` request is made.
- [Management authentication](https://github.com/lidge-jun/opencodex/blob/bba63222d3eeb5c8e397edae35798225e4fa1a6f/src/server/management-auth.ts):
  stock admin token in `Authorization: Bearer`. This is a broad Management API
  credential, not a scoped measurement token; it remains only on the Hub Agent.
- [Account label implementation](https://github.com/lidge-jun/opencodex/blob/bba63222d3eeb5c8e397edae35798225e4fa1a6f/src/codex/account-label.ts):
  Codex pool labels are `p` plus six hex characters; `main` is special. Generated
  labels attempt collision avoidance but fallback/truncated identities do not
  guarantee uniqueness. Missing/duplicate/conflicting labels fail closed on
  every accounts read. Meter does not infer provider identity from these labels.
- [Usage route](https://github.com/lidge-jun/opencodex/blob/bba63222d3eeb5c8e397edae35798225e4fa1a6f/src/server/management/logs-usage-routes.ts):
  `GET /api/usage?range=today|7d|30d|all&surface=codex`. A `read_failed` response
  can contain empty accounts/zero summary with HTTP 200; it is rejected as a
  failure, not accepted as zero.
- [Summary fields and aggregation](https://github.com/lidge-jun/opencodex/blob/bba63222d3eeb5c8e397edae35798225e4fa1a6f/src/usage/summary.ts):
  select only the matching `accountLogLabel` with `ambiguous=false`.
  Preserve `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
  `cacheCreationInputTokens`, `reasoningOutputTokens`, `totalTokens`, requests,
  attempt counts, `usageCoverageRatio`, `since` and `generatedAt`. These are Hub
  calendar/range semantics, not the Meter Server's native event timezone.
  An absent selected row in a valid response means no explicitly labelled ledger
  attempts: observed zero, coverage zero, not proof all usage was metered.
- [Quota schema](https://github.com/lidge-jun/opencodex/blob/bba63222d3eeb5c8e397edae35798225e4fa1a6f/src/codex/quota-types.ts)
  and [reset normalization](https://github.com/lidge-jun/opencodex/blob/bba63222d3eeb5c8e397edae35798225e4fa1a6f/src/providers/quota-wire.ts):
  weekly → 10080 minutes; monthly → 43200; short uses `shortWindowSeconds` (5H
  only when 18000). Resets and `updatedAt` are milliseconds. Missing resets are
  null. Custom windows have no duration in stock DTO: preserve percent/reset,
  use ordinal identifiers, and leave duration null. Do not invent periods from
  arbitrary labels. Short observations cannot be made fresh by a newer weekly
  update. Failed refreshes mark unavailable while retaining last-known-good.

The accounts endpoint may itself refresh stale Hub caches for multiple accounts.
This is stock Hub behavior: Meter never requests forced refresh, and polls usage
and quota at most once per minute per adapter (subject to Agent heartbeat and
upstream timeouts). Unselected responses exist only transiently in memory and
are discarded. This is not a promise that the stock Hub never probes its other
accounts.

## Storage, privacy and semantics

Native remains `native_rollout`: event-based, Device/Group/Profile attribution.
OpenCodex is `opencodex_proxy`: authoritative range summaries. Totals can include
the Hub's pre-attach ledger history; no aggregate delta is converted into fake
timestamped events. Coverage below 100%, ambiguous/read failures, stale data and
last-known-good are distinct. Hub totals are not added to Native Overview,
Device or Group totals; this avoids pretending that their time/origin semantics
are interchangeable (and avoids double counting overlapping observation).

New migrations only:

- Server `010_opencodex_sources.sql`: immutable Account source column, capability
  flag, logical Hub bindings, separate range current snapshots and quota current.
- Agent `007_opencodex_sources.sql`: selected label + Meter Profile/binding and
  connection IDs. No plaintext credential in SQLite. A private connection file
  holds URL and credential reference; optional stdin storage is a private secret
  file, separate from the connection.

Server receives only logical binding ID, state, four allowlisted numeric usage
summaries and normalized quota. It does not receive Hub URL, credential
reference/secret, logLabel, alias, plan/email/provider ID, auth or local paths.
There is no raw Hub response cache or Hub usage outbox. Failed upload is retried
by reading authoritative ranges again. Duplicate/older observations cannot
increase usage or refresh their observation timestamps. Stop/removal rejects
late uploads. Old binding snapshots are retained on stop/re-add but never summed
with a new binding's overlapping aggregate totals.

Capability negotiation uses a separate `x-codex-meter-opencodex` header and
dedicated Agent Hub endpoint. Native configuration schema is unchanged. Old
Agents cannot consume a Hub enrollment and receive no Hub declaration in their
Native config; new Agents do not poll Hub in runtime unless the Server advertises
support. Explicit attach against an old Server fails closed.

## Canary handoff

Synthetic tests must pass first. Then use a separate local Canary Server/DB and
Agent state, a newly created one-time enrollment and an explicitly provided Hub
URL/credential reference. Do not reuse earlier enrollment tokens. Run the local
picker, generate known requests through the selected Hub account, and compare
today/7d/30d/all and quota with OpenCodex's account view. Restart the Canary Agent
and verify values/selection. Check unselected labels, emails/IDs and credentials
are absent from Meter wire/storage. Do not report secret values or user paths.

The owner reports real OpenCodex Canary PASS for checkpoint
`0b0e34e63ec4cbbc81c86874cc4efa021be2efc8`. That result belongs to the pre-wizard
checkpoint only. The wizard tree needs a new real UX delta check: enrollment →
hidden credential input → explicit account selection → automatic usage/quota sync,
plus connection reuse and cancellation. Do not attribute the older result to the
new tree. This UX task does not modify existing Canary infrastructure or deploy.
