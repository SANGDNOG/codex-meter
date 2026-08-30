# Codex Meter V2 — Phase 0 validation toolkit

This directory is an **isolated, dependency-free, observation-only experiment kit**, not Codex Meter V2. Its purpose is to collect evidence before any V2 accounting or quota design is chosen. It does not change the wrapper, production parser, server, state format, UI, quota enforcement, or watcher behavior.

The App Server client hard-allowlists only `initialize`, `account/read` (with `refreshToken: false`), `account/rateLimits/read`, and `account/usage/read`. It never starts, resumes, attaches to, forks, or mutates a thread and never calls login/logout. It does not open `auth.json`.

Run commands from the repository root with Node.js 22+. Real observations belong under `phase0-output/`, which is gitignored and written with private file permissions. Do not point `--output` at a tracked directory.

## August 2026 source contract

The schema review for this toolkit used OpenAI Codex commit `6478a751fde8884b2fdc76486fe23175a8e795d4` (2026-08-29):

- App Server account quota and token-usage schemas: `codex-rs/app-server-protocol/src/protocol/v2/account.rs`
- Optional per-thread usage schema: `codex-rs/app-server-protocol/src/protocol/v2/thread_usage.rs`
- `SessionMeta`, `TurnContext`, `SessionSource`, `TokenUsage`, `TokenUsageInfo`, `TokenCountEvent`, and rollout rate-limit schemas: `codex-rs/protocol/src/protocol.rs`
- active/archive discovery, compression, history bases, and revert behavior: `codex-rs/thread-store/**` and `codex-rs/rollout/**`

These paths describe that upstream revision, not an eternal provider contract. Always record the installed Codex version in a real experiment and preserve unknown/ambiguous results.

## Privacy and evidence labels

The rollout scanner streams complete JSONL lines and keeps only an explicit structural allowlist. It never copies whole records or recursively searches arbitrary payloads. Prompts, responses, reasoning, source code, tool inputs/outputs, environment variables, `cwd`, paths, credentials, raw App Server responses, and diagnostics are excluded. Session, thread, rollout/file, parent, fork, history-base, and subagent identifiers are HMAC-pseudonymized by default with `phase0-output/.probe-secret`. Keep this secret private. `--raw-session-ids` is for explicit local debugging only; paths are still never exposed.

Inspect sanitized output before sharing it: a future format could put an unexpected value in an allowlisted field. Never share the probe secret, Codex home, rollout JSONL, or `auth.json`.

Use these labels consistently:

| Label | Meaning | Example |
| --- | --- | --- |
| `measured` | Numeric value read from local evidence | local JSONL token counter |
| `provider_reported` | Value reported by Codex/App Server | displayed quota percentage or reset time |
| `inferred` | Conclusion supported by explicit structural evidence | confirmed inherited child baseline |
| `experimental` | Relationship being tested, not established | tokens per displayed percentage point |
| `ambiguous` | Available evidence cannot distinguish explanations | child first event may include child work |
| `unavailable` | Signal/method was absent or unsupported | unsupported account usage method |

Do not promote an experimental ratio to quota attribution. Matching devices are only consistent with shared account/workspace scope. A new file is not proof of new usage, and the same logical thread ID is not proof of the same physical rollout.

## Recommended real-machine order and exact commands

Use a disposable test thread with no sensitive content. Run each command from the repository root. Save the “before” output before doing the named action through normal Codex CLI/IDE/App controls; this toolkit performs no thread action itself.

### 1. Test the kit

```sh
npm test
```

### 2. Probe read-only App Server capabilities

```sh
node tools/phase0/app-server-probe.js \
  --output phase0-output/app-server.json
```

### 3. Capture the baseline rollout state

```sh
node tools/phase0/rollout-inspector.js \
  --output phase0-output/rollout-00-baseline.json
node tools/phase0/lineage-inspector.js \
  --input phase0-output/rollout-00-baseline.json \
  --output phase0-output/lineage-00-baseline.json --text
node tools/phase0/accounting-analyzer.js \
  --input phase0-output/rollout-00-baseline.json \
  --output phase0-output/accounting-00-baseline.json
```

### 4. Perform one controlled normal Codex turn, then inspect

```sh
node tools/phase0/rollout-inspector.js \
  --output phase0-output/rollout-01-normal.json
node tools/phase0/lineage-inspector.js \
  --input phase0-output/rollout-01-normal.json \
  --output phase0-output/lineage-01-normal.json --text
node tools/phase0/accounting-analyzer.js \
  --input phase0-output/rollout-01-normal.json \
  --output phase0-output/accounting-01-normal.json
```

### 5. Resume that thread, perform one controlled turn, then inspect

```sh
node tools/phase0/rollout-inspector.js \
  --output phase0-output/rollout-02-resume.json
node tools/phase0/lineage-inspector.js \
  --input phase0-output/rollout-02-resume.json \
  --output phase0-output/lineage-02-resume.json --text
node tools/phase0/accounting-analyzer.js \
  --input phase0-output/rollout-02-resume.json \
  --output phase0-output/accounting-02-resume.json
```

### 6. Fork through normal Codex controls, perform one child turn, then inspect

```sh
node tools/phase0/rollout-inspector.js \
  --output phase0-output/rollout-03-fork.json
node tools/phase0/lineage-inspector.js \
  --input phase0-output/rollout-03-fork.json \
  --output phase0-output/lineage-03-fork.json --text
node tools/phase0/accounting-analyzer.js \
  --input phase0-output/rollout-03-fork.json \
  --output phase0-output/accounting-03-fork.json
```

### 7. Spawn a subagent through supported Codex controls, then inspect

```sh
node tools/phase0/rollout-inspector.js \
  --output phase0-output/rollout-04-subagent.json
node tools/phase0/lineage-inspector.js \
  --input phase0-output/rollout-04-subagent.json \
  --output phase0-output/lineage-04-subagent.json --text
node tools/phase0/accounting-analyzer.js \
  --input phase0-output/rollout-04-subagent.json \
  --output phase0-output/accounting-04-subagent.json
```

### 8. If safely reproducible, revert through normal Codex controls, continue once, then inspect

```sh
node tools/phase0/rollout-inspector.js \
  --output phase0-output/rollout-05-revert.json
node tools/phase0/lineage-inspector.js \
  --input phase0-output/rollout-05-revert.json \
  --output phase0-output/lineage-05-revert.json --text
node tools/phase0/accounting-analyzer.js \
  --input phase0-output/rollout-05-revert.json \
  --output phase0-output/accounting-05-revert.json
```

Do not edit or corrupt rollouts to manufacture a revert. Current Codex can preserve a logical thread ID while creating a different physical rollout with a history cutoff. The analyzer uses explicit history/lineage evidence to avoid counting inherited history twice; if reconstruction is not reliable, it reports `ambiguous` rather than guessing.

### 9. Compare a second-device quota snapshot

On the first machine:

```sh
node tools/phase0/quota-snapshot.js \
  --device-label desktop \
  --output phase0-output/desktop-quota.json
```

On the second machine, with the same intended account/workspace selected and as close in time as practical:

```sh
node tools/phase0/quota-snapshot.js \
  --device-label laptop \
  --output phase0-output/laptop-quota.json
```

Copy only the sanitized snapshots to one private machine, then run:

```sh
node tools/phase0/quota-snapshot.js \
  --compare phase0-output/desktop-quota.json phase0-output/laptop-quota.json
```

Windows are matched by stable observable properties such as opaque `limitId` plus actual `windowDurationMins`; `primary`/`secondary` are only observed slots and may reorder. Duplicate candidate identities are ambiguous. Matching percentages, resets, plan metadata, and window identities do **not** prove globally shared scope: time drift, quantization, intervening activity, workspace selection, credits, resets, spend controls, and provider reconfiguration can confound the result.

### 10. Record a controlled quota-calibration observation

Ensure other devices and Codex Web/Work/IDE activity are idle. Keep model, reasoning effort, and service/speed tier fixed, choose a quota window far from reset, and do not span a reset.

```sh
node tools/phase0/calibration-recorder.js start test-001 \
  --model gpt-5 --reasoning-effort high --service-tier default
# Perform the controlled workload through Codex, without running other account work.
node tools/phase0/calibration-recorder.js finish test-001
```

The output keeps `estimator: null`. It records sanitized before/after quota data, confounders, and observed local input, cached input, uncached/fresh input, cache-write input, output, reasoning output, total, and—if present—rollout-budget dimensions. Displayed `usedPercent` is quantized: **unchanged usedPercent != zero quota cost**, and **+1 displayed point != exact continuous 1%**. Ratios are emitted only for positive displayed movement and remain `experimental`, never account quota attribution.

Use `--codex-home /configured/codex/home` or `--sessions /specific/sessions` when appropriate; `CODEX_HOME` otherwise wins over `~/.codex`. Use `--secret-file /private/stable/secret` only when you intentionally need stable pseudonyms across output directories.

## What each probe proves—and does not prove

### App Server account usage

`account/usage/read` currently has an account-wide `summary` (`lifetimeTokens`, `peakDailyTokens`, `longestRunningTurnSec`, `currentStreakDays`, `longestStreakDays`), optional `dailyUsageBuckets[]` (`startDate`, `tokens`), and optional `threadUsage`. Phase 0 sends no `threadId`; it allowlists account fields and records whether thread usage was present/available without making a thread-specific request. It preserves useful absent-versus-`null` distinctions and marks a successful but unrecognized shape explicitly. A malformed response is not “supported.”

This proves only what the installed App Server returned at probe time. Account token activity is not the same thing as quota cost, billing, or local rollout attribution. Optional `threadUsage`, when requested by some other client, is an estimated credits/USD/token breakdown; this toolkit deliberately does not request it.

### Local token usage and rollout budget units

Ordinary `TokenUsage` dimensions remain separate: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, and `total_tokens`. Missing is not zero; regressions are reported, not silently clamped. Reasoning output and budget units are never added to ordinary token sums.

At the reviewed upstream commit, `codex_rollout_budget_units` is an optional `serde_json::Number` described as provider-reported units consumed from a shared rollout budget, but it has `skip_serializing` and is therefore **transient/not serialized by that upstream implementation**. The toolkit still safely observes a finite, non-negative decimal if a future or variant rollout emits it. It remains a separate `provider_reported`/`experimental` workload dimension—not a token count and not evidence of account quota consumption.

### `token_count.rate_limits`

Current `TokenCountEvent` can carry optional `info` and optional `rate_limits`. The scanner records whether each token-count event had rate-limit data and sanitizes only opaque limit identity, actual window duration, displayed usage/reset data, and relevant non-sensitive plan/rate metadata. It does not assume `primary` means five hours or `secondary` means weekly, and it retains no raw provider object.

A nearby local token counter and provider snapshot enables temporal comparison; it does not establish causation, quota attribution, or that rate limits are populated every turn.

### Lineage, baselines, and revert

The scanner distinguishes session/thread IDs, physical rollout/file identity, parent/fork IDs, fork cutoff ordinals, history-base source/cutoff/byte offset, subagent start metadata, and structurally allowlisted subagent source metadata where upstream provides them. Distinct IDs are not collapsed. Prompt/tool payload objects cannot supply lineage metadata.

A child's first cumulative value is only an `inheritedBaselineCandidate`. `baselineStatus` and `baselineEvidence` explain whether explicit parent/history/cutoff and compatible parent state support an `inferred` confirmed baseline. If the first child event could already include child work, the parent is missing, metadata conflicts, or counters regress, lineage accounting is `ambiguous`; the analyzer does not blindly subtract the first value.

For revert, logical thread identity can remain stable while rollout identity changes. Explicit history cutoffs can support deduplication; a same thread ID alone cannot. Unreconstructable inherited history stays ambiguous.

### Active, archived, and compressed rollouts

The inspector searches active `sessions` and `archived_sessions`. This dependency-free implementation uses **Option B (detection first)** for `.jsonl.zst`: it detects compressed candidates but does not decode them. Output reports `compressedRolloutsDetected`, `archivedRolloutsDetected`, and `scanCompleteness`. Unread compressed history that may affect accounting makes results incomplete/ambiguous, and plain/compressed representations of the same logical rollout are not silently counted twice.

Detection proves that relevant storage exists, not what is inside compressed history. `scanCompleteness: incomplete_compressed` must not be presented as complete accounting.

## Accounting strategies and remaining empirical questions

The analyzer exposes naive cumulative and summed last-usage views for comparison, plus conservative lineage-aware accounting. Only explicit structural evidence can confirm inherited history. Multiple roots, missing parents, uncertain baselines, counter regression, retained-event truncation, unread compression, or unreliable cross-file ordering lower confidence.

Real experiments are still required to learn:

- whether `codex_rollout_budget_units` is emitted by the installed Codex/provider/account variant despite being non-serialized in reviewed upstream;
- whether budget units or any local token dimension correlates with account quota drain;
- whether rollout `token_count.rate_limits` is populated every turn;
- whether two devices observe exactly the same quota scope;
- how the installed version behaves for resume, fork, structured subagents, revert, archive, and compression;
- whether a child first cumulative snapshot is a pure inherited baseline or already includes child work.

Phase 0 collects evidence. It intentionally does not invent an estimator or force ambiguous observations into a Phase 1 design.
