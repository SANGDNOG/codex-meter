import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectRollouts } from '../tools/phase0/shared/rollout.js';
import { analyzeAccounting, buildLineage } from '../tools/phase0/shared/accounting.js';
import { cleanTokens, addTokens } from '../tools/phase0/shared/core.js';
import { calibrationInterval, usageFrom } from '../tools/phase0/calibration-recorder.js';

const fixtureRoot = path.join(import.meta.dirname, '..', 'tools', 'phase0', 'fixtures');
const secret = Buffer.alloc(32, 9);
const fixed = '2026-08-29T00:00:00.000Z';
const names = {
  parent: 'rollout-2026-08-01T00-00-00-11111111-1111-4111-8111-111111111111.jsonl',
  confirmed: 'rollout-2026-08-01T00-01-00-22222222-2222-4222-8222-222222222222.jsonl',
  uncertain: 'rollout-2026-08-01T00-02-00-33333333-3333-4333-8333-333333333333.jsonl',
  missing: 'rollout-2026-08-01T00-03-00-44444444-4444-4444-8444-444444444444.jsonl',
  ambiguous: 'rollout-2026-08-01T00-04-00-55555555-5555-4555-8555-555555555555.jsonl',
  regression: 'rollout-2026-08-01T00-05-00-66666666-6666-4666-8666-666666666666.jsonl',
  original: 'rollout-2026-08-01T00-06-00-77777777-7777-4777-8777-777777777777.jsonl',
  reverted: 'rollout-2026-08-01T00-07-00-88888888-8888-4888-8888-888888888888.jsonl'
};
async function inspectFixtures(keys) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phase0-update-'));
  for (const key of keys) await copyFile(path.join(fixtureRoot, names[key]), path.join(root, names[key]));
  return inspectRollouts({ root, secret, now: fixed, codexVersion: 'codex test' });
}

test('August rollout schema keeps IDs distinct, structured source structural, rate limits sanitized, and budget units separate', async () => {
  const inspection = await inspectFixtures(['parent', 'confirmed']);
  const childFile = inspection.files.find((file) => file.events.some((event) => event.forkedFromId));
  const meta = childFile.events[0]; const firstCount = childFile.events[1];
  assert.notEqual(meta.sessionId, meta.threadId);
  assert.equal(meta.source, 'subagent_thread_spawn');
  assert.equal(meta.sourceRelation.parentId, meta.forkedFromId);
  assert.equal(meta.forkedFromOrdinalExclusive, 4);
  assert.equal(meta.historyBase.endOrdinalExclusive, 4);
  assert.equal(meta.subagentHistoryStartOrdinal, 4);
  assert.match(childFile.rolloutId, /^hmac:/);
  assert.equal(firstCount.totalUsage.codex_rollout_budget_units, 1.25);
  assert.equal(firstCount.rateLimitsPresent, true);
  assert.deepEqual(firstCount.rateLimits.windows[0], { slot: 'primary', durationMinutes: 360, usedPercent: 12.5, resetsAt: 1785542400 });
  assert.equal(firstCount.rateLimits.credits.balance, '12.50');
  assert.equal(childFile.events[2].rateLimitsPresent, false);
  const accounting = analyzeAccounting(inspection, { now: fixed });
  assert.equal(accounting.strategies.lineageAware.totalTokens, 130);
  assert.equal(accounting.experimentalDimensions.codexRolloutBudgetUnits.arithmeticIncludedInTokenTotals, false);
  assert.deepEqual(accounting.experimentalDimensions.codexRolloutBudgetUnits.cumulativeObservedValues, [1.25, 1.75]);
  assert.deepEqual(accounting.experimentalDimensions.codexRolloutBudgetUnits.lastUsageObservedValues, [0.25, 0.5]);
  const baseline = analyzeAccounting(await inspectFixtures(['parent']), { now: fixed });
  const interval = calibrationInterval(usageFrom(accounting), usageFrom(baseline));
  assert.deepEqual(interval.usage.codex_rollout_budget_units_observations, [0.25, 0.5]);
  assert.equal(interval.usage.codex_rollout_budget_units, 0.75);
});

test('rollout budget units accept finite nonnegative decimals, reject invalid values, and never enter token arithmetic', () => {
  for (const invalid of [-1, Infinity, NaN, '1.5']) assert.equal(cleanTokens({ total_tokens: 2, codex_rollout_budget_units: invalid }).codex_rollout_budget_units, undefined);
  const decimal = cleanTokens({ total_tokens: 2, codex_rollout_budget_units: 0.125 });
  assert.equal(decimal.codex_rollout_budget_units, 0.125);
  assert.equal(addTokens(decimal, decimal).codex_rollout_budget_units, undefined);
  assert.equal(addTokens(decimal, decimal).total_tokens, 4);
});

test('baseline schema confirms only matching parent-at-fork plus zero initial child usage', async () => {
  const lineage = buildLineage(await inspectFixtures(['parent', 'confirmed']), { now: fixed });
  const child = lineage.nodes.find((node) => node.relation === 'fork');
  assert.equal(child.baselineStatus, 'confirmed');
  assert.equal(child.inheritedBaselineCandidate.total_tokens, 100);
  assert.deepEqual(child.baselineEvidence, [
    'explicit_fork_relation', 'fork_cutoff_observed',
    'candidate_matches_observed_parent_cumulative_at_fork', 'initial_last_usage_zero'
  ]);
});

test('first child event containing work remains ambiguous and is not subtracted', async () => {
  const result = analyzeAccounting(await inspectFixtures(['parent', 'uncertain']), { now: fixed });
  const baseline = result.strategies.lineageAware.baselines.find((item) => item.baselineStatus === 'ambiguous');
  assert.equal(baseline.inheritedBaselineCandidate.total_tokens, 110);
  assert.equal(result.strategies.lineageAware.totalTokens, 210);
  assert.equal(result.strategies.lineageAware.quality, 'ambiguous');
});

test('missing parent and structurally incomplete subagent metadata stay ambiguous', async () => {
  const missing = analyzeAccounting(await inspectFixtures(['missing']), { now: fixed });
  assert.equal(missing.strategies.lineageAware.baselines[0].baselineStatus, 'missing_parent');
  assert.match(missing.ambiguous.join('\n'), /outside the inspected data/);
  const ambiguous = analyzeAccounting(await inspectFixtures(['ambiguous']), { now: fixed });
  assert.equal(ambiguous.strategies.lineageAware.quality, 'ambiguous');
  assert.match(ambiguous.ambiguous.join('\n'), /no explicit parent/);
});

test('current cumulative counter regression remains explicit', async () => {
  const result = analyzeAccounting(await inspectFixtures(['regression']), { now: fixed });
  assert.equal(result.strategies.lineageAware.quality, 'ambiguous');
  assert.match(result.ambiguous.join('\n'), /regressed.*total_tokens/);
});

test('revert keeps stable logical ID, distinct physical rollout IDs, avoids summing inherited history, and reports ambiguity', async () => {
  const inspection = await inspectFixtures(['original', 'reverted']);
  const lineage = buildLineage(inspection, { now: fixed });
  assert.equal(lineage.nodes.length, 1);
  assert.equal(lineage.nodes[0].physicalRolloutIds.length, 2);
  assert.equal(lineage.nodes[0].historyBases.length, 1);
  const revertedFile = inspection.files.find((file) => file.events[0].historyBase);
  const originalFile = inspection.files.find((file) => file !== revertedFile);
  assert.equal(revertedFile.events[0].historyBase.rolloutId, originalFile.rolloutId);
  const accounting = analyzeAccounting(inspection, { now: fixed });
  assert.equal(accounting.strategies.naiveCumulative.totalTokens, 180);
  assert.equal(accounting.strategies.lineageAware.totalTokens, 100);
  assert.equal(accounting.strategies.lineageAware.quality, 'ambiguous');
  assert.match(accounting.ambiguous.join('\n'), /revert\/inherited-history/);
});

test('default discovery scans active and archive and Option B detects/dedupes zst with plain precedence', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'phase0-home-'));
  const active = path.join(home, 'sessions', '2026', '08', '01'); const archived = path.join(home, 'archived_sessions');
  await mkdir(active, { recursive: true }); await mkdir(archived, { recursive: true });
  await copyFile(path.join(fixtureRoot, names.parent), path.join(active, names.parent));
  await writeFile(path.join(active, `${names.parent}.zst`), 'not decoded');
  await copyFile(path.join(fixtureRoot, names.confirmed), path.join(archived, names.confirmed));
  const compressedOnly = 'rollout-2026-08-01T00-09-00-99999999-9999-4999-8999-999999999999.jsonl.zst';
  await writeFile(path.join(archived, compressedOnly), 'not decoded');
  const inspection = await inspectRollouts({ home, secret, now: fixed, codexVersion: 'test' });
  assert.equal(inspection.files.length, 2);
  assert.equal(inspection.files.filter((file) => file.archived).length, 1);
  assert.equal(inspection.compressedRolloutsDetected, true);
  assert.equal(inspection.archivedRolloutsDetected, true);
  assert.equal(inspection.scan.compressedOnlyRolloutCount, 1);
  assert.equal(inspection.scanCompleteness, 'incomplete_compressed');
  const accounting = analyzeAccounting(inspection, { now: fixed });
  assert.equal(accounting.strategies.lineageAware.quality, 'ambiguous');
  assert.match(accounting.ambiguous.join('\n'), /compressed-only/);
});

test('structured metadata extraction ignores adversarial lookalike keys outside SessionMeta', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phase0-privacy-update-'));
  const filename = 'rollout-2026-08-01T00-10-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl';
  await writeFile(path.join(root, filename), [
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', source: { subagent: { thread_spawn: { parent_thread_id: 'SECRET_PARENT' } } }, history_base: { thread_id: 'SECRET_ROLLOUT' }, codex_rollout_budget_units: 999 } }),
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'runtime-safe', id: 'thread-safe', source: 'cli' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1 } } } }), ''
  ].join('\n'));
  const inspection = await inspectRollouts({ root, secret, now: fixed, codexVersion: 'test' });
  const text = JSON.stringify(inspection);
  assert.equal(text.includes('SECRET_PARENT'), false);
  assert.equal(text.includes('SECRET_ROLLOUT'), false);
  assert.equal(text.includes('999'), false);
  assert.equal(inspection.files[0].events.some((event) => event.sourceRelation), false);
});
