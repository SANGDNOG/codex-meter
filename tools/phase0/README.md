# Codex Meter V2 — Phase 0 validation toolkit

This directory is an **isolated, dependency-free experiment kit**, not Codex Meter V2. It does not change the wrapper, production parser, server, state format, UI, quota enforcement, or watcher behavior. Every App Server request is hard-allowlisted to `initialize`, `account/read` (with `refreshToken: false`), `account/rateLimits/read`, and `account/usage/read`. The toolkit never starts, resumes, attaches to, or forks a thread and never calls login/logout. It does not open `auth.json`.

Run commands from the repository root with Node.js 22+. Generated observations default to `phase0-output/`, which is gitignored and written with private file permissions. Do not override `--output` into a tracked directory for real observations.

## Privacy and interpretation

The rollout scanner streams complete JSONL lines and retains only an explicit allowlist of structural identifiers, event types, timestamps, model/config atoms, lineage atoms, and numeric token counters. It never copies whole events and intentionally excludes content, prompts, responses, tool inputs/outputs, environment data, `cwd`, source text, and paths. File identities and session IDs are HMAC pseudonyms by default, using a local `phase0-output/.probe-secret`. Keep that secret private if you need stable IDs across scans. `--raw-session-ids` is intended only for local debugging; file paths remain pseudonymized. The scanner handles malformed lines, partial final lines, bounded oversized lines, appends visible during a stream, and files that disappear during scanning without loading an entire file.

Inspect outputs before sharing them. A future Codex format could place an unexpected value in an allowlisted field. Never share the probe secret, Codex home, session JSONL, or `auth.json`.

All output schemas contain `schemaVersion`, `probeVersion`, `probe`, timestamp, and Codex version when available. `primary` and `secondary` are retained only as opaque window slots; duration comes from window metadata. Limit IDs are opaque. Equality between machines is evidence, not proof, of account/workspace scope.

## Commands

```sh
npm test

node tools/phase0/app-server-probe.js \
  --output phase0-output/app-server.json

node tools/phase0/quota-snapshot.js \
  --device-label desktop \
  --output phase0-output/desktop-quota.json

node tools/phase0/quota-snapshot.js \
  --compare phase0-output/desktop-quota.json phase0-output/laptop-quota.json

node tools/phase0/rollout-inspector.js \
  --output phase0-output/rollout-inspection.json

node tools/phase0/lineage-inspector.js \
  --input phase0-output/rollout-inspection.json \
  --output phase0-output/lineage.json --text

node tools/phase0/accounting-analyzer.js \
  --input phase0-output/rollout-inspection.json \
  --output phase0-output/accounting.json

node tools/phase0/calibration-recorder.js start test-001 \
  --model gpt-5 --reasoning-effort high --service-tier default
# Perform the controlled workload. Finish captures the new local snapshot and
# subtracts the sanitized cumulative baseline recorded by start:
node tools/phase0/calibration-recorder.js finish test-001
```

Use `--codex-home /configured/codex/home` or `--sessions /specific/sessions` with the rollout inspector when `CODEX_HOME` is not appropriate. `CODEX_HOME` otherwise wins over `~/.codex`. Use `--secret-file /private/stable/secret` to correlate pseudonyms across output directories.

## Experiment 1 — App Server capabilities

1. Run the App Server probe command above while Codex authentication is already configured.
2. Inspect `capabilities.accountRead`, `capabilities.rateLimits`, `capabilities.accountUsage`, and per-method `errors`.
3. `true` means the initialized App Server answered that read method. An `unsupported` error means the installed protocol does not expose it. A request/initialization failure can instead mean authentication, process, timeout, or version trouble and must not be interpreted as unsupported.
4. `threadUsage` remains `false`: Phase 0 deliberately makes no thread request.

No raw App Server response or diagnostics are emitted. Account output is limited to type/plan type, and rate-limit output to opaque IDs/names, plan type, duration, displayed usage, and reset time.

## Experiment 2 — two devices

1. On Desktop, while the intended account/workspace is selected:
   ```sh
   node tools/phase0/quota-snapshot.js --device-label desktop --output phase0-output/desktop-quota.json
   ```
2. On Laptop, logged into the same selected account/workspace, run within a short interval:
   ```sh
   node tools/phase0/quota-snapshot.js --device-label laptop --output phase0-output/laptop-quota.json
   ```
3. Copy only those sanitized JSON snapshots to one private machine.
4. Run `--compare` as shown above. Compare `limitId`, actual duration, `usedPercent`, `resetsAt`, and `planType`.

Differences are reported explicitly. Matching observations are merely consistent with shared scope; time drift, intervening usage, quantization, multiple workspaces, or provider updates can confound the experiment.

## Experiment 3 — fork/subagent lineage

1. Run the rollout inspector and preserve the first sanitized output as a baseline.
2. Start a fresh Codex thread normally (outside this toolkit).
3. Perform several controlled turns.
4. Spawn a subagent or fork using normal supported Codex UI/CLI behavior.
5. Perform one child action and then exit Codex normally.
6. Run rollout inspector, lineage inspector, and accounting analyzer with the commands above.
7. Look for an **explicit** child parent/fork/subagent ID and an `inheritedBaselineCandidate` equal to the child's first cumulative counter. Later child growth above that candidate supports inherited cumulative usage. A lower lineage-aware result than naive cumulative is analytical evidence, not proof of provider billing semantics.

The toolkit never creates the fork/subagent itself. If no explicit relationship is present, it reports ambiguity rather than matching by timing or filename.

## Experiment 4 — new/resume/fork/subagent, exit/crash, and probe interruption

Use a disposable test thread with no sensitive prompt content. For each of `new`, normal `resume`, normal `fork`, and supported `subagent`: capture a before inspection, perform one small action through normal Codex controls, exit normally, capture after, then run lineage/accounting. Repeat normal exit once with an intentional Codex termination (prefer Ctrl-C; do not corrupt configuration). To test meter-probe interruption, interrupt only `rollout-inspector.js` with Ctrl-C and rerun it; it has no cursor/state to damage. Do not kill Codex while it is writing merely to manufacture corruption, and do not edit/delete sessions or configuration. Partial lines and disappearing synthetic files are covered by automated fixtures.

Check whether resume reuses the same observed session ID/cumulative state, whether children begin with parent-like cumulative values, and whether any case is marked ambiguous. A file being new is not treated as proof of new usage.

## Experiment 5 — controlled quota calibration

1. Ensure one active local device; avoid Codex Web, Work, IDE, and other account surfaces during the observation.
2. Keep model, reasoning effort, and service/speed tier fixed where possible.
3. Choose a window whose reset is sufficiently far away; do not span a reset.
4. Run `calibration-recorder.js start`, perform a batch of controlled turns, then run `finish`. The recorder captures sanitized local cumulative accounting at both boundaries and records their positive difference. `finish --usage phase0-output/accounting.json` is available only when you intentionally want to supply a separately captured post-workload accounting file.
5. Record suspected overlap or external interference separately when interpreting the JSON. These precautions do **not** eliminate all external activity or provider-side effects.

This is not an estimator. It stores displayed before/after percentages and local token dimensions. `usedPercent` can be coarse: unchanged display does not mean exactly zero cost, and a one-point change is not exactly one continuous percentage point. Batch enough turns to have a chance of crossing a visible quantum. Experimental tokens-per-displayed-point is emitted only for a positive displayed change and must not be promoted to quota attribution.

## Accounting strategies and limitations

The analyzer reports raw dimensions for:

* **naive cumulative** — maximum cumulative value per file;
* **sum last usage** — sums every observed `last_token_usage`, warning when absent;
* **lineage-aware** — deduplicates identical explicit session IDs and subtracts a child's first cumulative value only when an explicit parent/fork/subagent relationship exists.

`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, and `total_tokens` remain separate. Reasoning output is never added to output or total. Relationships are not inferred from timing, paths, or similar counters. Missing explicit lineage yields `quality: ambiguous`. Phase 0 results must be collected before designing any Phase 1 accounting engine.
