# V2.2 OpenCodex candidate validation — 2026-09-07

## Baseline

- Actual fetched `origin/main`: `654729dadd8d1c4d0b3841fadcd25e8c9da50878`.
- Branch: `feature/v2.2-opencodex-hub`.
- Before changes: npm test 319/319; V1 68/68; V2 251/251.
- Baseline/final default Node: 22.22.3; additional supported-engine run: 24.15.0.
- All reported runs have zero failures, skips, cancellations and todos.

## Final automated validation

| Command/scope | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| npm test | 378 | 378 | 0 | 0 |
| npm run test:v1 | 68 | 68 | 0 | 0 |
| npm run test:v2 | 310 | 310 | 0 | 0 |
| Node 24.15.0: npm run test:v2 | 310 | 310 | 0 | 0 |
| OpenCodex focused | 56 | 56 | 0 | 0 |
| Hub + existing environment + onboarding DOM focused | 109 | 109 | 0 | 0 |

The focused/supported-engine suites overlap the full suite; totals must not be
added together as independent tests. This is 59 additional tests versus the
319-test baseline, not reuse of old validation evidence.

- `npm run check:syntax`: 80 JavaScript files PASS.
- `sh -n v2/install/install.sh`: PASS.
- `git diff --check`, `git diff --cached --check`: PASS; nothing staged.
- `npm audit --omit=dev`: 0 vulnerabilities; no dependency upgrade.
- Old migration files unchanged; new Server 010 and Agent 007 only.
- Source privacy scan: no actual operator Home paths, private keys, live-key/JWT
  patterns found in changed/new files. Synthetic sentinel tests additionally
  reject Hub credential, URL, account labels, raw IDs/emails and unselected data
  in Meter reports and snapshot storage. This is not a claim that a regex scan
  alone proves privacy.

Logs are in `/tmp/codex-meter-v22-final-{full,v1,v2,node24-v2,focused}.log` and
`/tmp/codex-meter-v22-hub-focused.log` in this development environment.

## Independent review

Fresh review-only subagent: `gpt-5.6-luna`, reasoning `xhigh`.
No code modifications by reviewer. Actual diff, untracked modules, tests and
public upstream source inspected. Final verdict C0/H0/M0/L0, PASS.

One initial Medium was validated and fixed: after a transient failure, an
identical cached quota timestamp could leave status stuck unavailable. Equal
timestamp recovery now requires the identical allowlisted snapshot, restores
availability without renewing observed freshness, and has a regression test.
The reviewer rechecked closure. Its independent full run was 377/377 before
the last additional two-account/restart test; the main agent's final candidate
run including that test is 378/378 above. Application code did not change after
that review.

## Scope and integration status

See [implementation/API/usage contract](v2-opencodex-hub.md) for exact upstream
commit, public APIs, field mappings, credential handling, supported local inputs,
coverage semantics and Canary procedure.

- Real OpenCodex integration: **NOT RUN**. Requires an explicitly supplied
  Canary Hub URL, Agent-local credential reference and account selection.
- No real credentials inferred, scraped, logged, persisted in this repo or sent
  to a Meter Server. Synthetic HTTP and DOM tests are not a real provider Canary.
- Browser command unavailable; repository happy-dom tests were used. No claim
  of a native Chromium visual check or Windows/macOS runtime verification.
- No commit, push, main merge, tag, release or production deployment.
- `main`, `origin/main` and published `v2-agent-2.1.3` remain at the baseline SHA.

## Intended files

Agent: attach-existing.js, cli.js, config.js, runtime.js, sync.js, opencodex.js.
Server: http.js, service.js, hub.js. Shared: hub-snapshot.js.
Web: app.js. Migrations: server/010_opencodex_sources.sql,
agent/007_opencodex_sources.sql.
Tests: v2-opencodex.test.js, v2-existing-environment.test.js,
v2-m1-database.test.js, v2-v21-onboarding-ux.test.js.
Docs: v2-opencodex-hub.md, this validation report.

READY FOR OPENCODEX CANARY
