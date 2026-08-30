import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeAccountUsage,
  normalizeRateLimitSnapshot,
  normalizeRateLimits
} from '../tools/phase0/shared/app-server-client.js';
import { runAppServerProbe } from '../tools/phase0/app-server-probe.js';
import { compareSnapshots } from '../tools/phase0/quota-snapshot.js';
import { calibrationInterval, finishObservation, usageFrom } from '../tools/phase0/calibration-recorder.js';

const fixed = '2026-08-29T12:00:00.000Z';

function snapshot(deviceLabel, windows, extra = {}) {
  return {
    timestamp: fixed,
    deviceLabel,
    planType: 'pro',
    quota: { limits: [{ limitId: 'codex', planType: 'pro', windows, ...extra }], rateLimitResetCredits: null }
  };
}

test('current account usage schema preserves null, absent, buckets, and threadUsage presence semantics', () => {
  const value = normalizeAccountUsage({
    summary: {
      lifetimeTokens: 1234,
      peakDailyTokens: null,
      longestRunningTurnSec: 91,
      currentStreakDays: 3,
      longestStreakDays: 7,
      email: 'private@example.com'
    },
    dailyUsageBuckets: [{ startDate: '2026-08-28', tokens: 42, prompt: 'secret' }],
    threadUsage: null,
    diagnostic: 'do not retain'
  });
  assert.deepEqual(value.summary, {
    lifetimeTokens: 1234,
    peakDailyTokens: null,
    longestRunningTurnSec: 91,
    currentStreakDays: 3,
    longestStreakDays: 7
  });
  assert.deepEqual(value.dailyUsageBuckets, [{ startDate: '2026-08-28', tokens: 42 }]);
  assert.deepEqual(value.threadUsage, { present: true, available: false });
  assert.equal(value.fieldsRecognized, true);
  assert.equal(JSON.stringify(value).includes('private@example.com'), false);
  assert.equal(normalizeAccountUsage({ summary: {}, threadUsage: {} }), null);
  assert.deepEqual(normalizeAccountUsage({ summary: {}, threadUsage: {
    threadId: 'thread', estimatedUsageCreditsMicros: 1, estimatedUsageUsdMicros: null, groups: []
  } }).threadUsage, { present: true, available: true });

  const absent = normalizeAccountUsage({ summary: {} });
  assert.deepEqual(absent.threadUsage, { present: false, available: false });
  assert.equal(absent.fieldsRecognized, false);
});

test('malformed account usage is rejected and does not set App Server support', async () => {
  assert.equal(normalizeAccountUsage({ dailyUsageBuckets: [] }), null);
  assert.equal(normalizeAccountUsage({ summary: {}, dailyUsageBuckets: 'bad' }), null);

  const root = await mkdtemp(path.join(os.tmpdir(), 'phase0-malformed-server-'));
  const executable = path.join(root, 'fake-server');
  await writeFile(executable, `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('fake 1');process.exit(0)}const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const x=JSON.parse(line);if(x.method==='initialize')return process.stdout.write(JSON.stringify({id:x.id,result:{}})+'\\n');if(x.method==='initialized')return;if(x.method==='account/read')return process.stdout.write(JSON.stringify({id:x.id,result:{account:{type:'chatgpt',planType:'pro'}}})+'\\n');if(x.method==='account/rateLimits/read')return process.stdout.write(JSON.stringify({id:x.id,result:{rateLimits:{limitId:'codex',primary:{windowDurationMins:60,usedPercent:1,resetsAt:10}}}})+'\\n');process.stdout.write(JSON.stringify({id:x.id,result:{unexpected:true}})+'\\n')})\n`);
  await chmod(executable, 0o700);
  const result = await runAppServerProbe({ command: executable, timeoutMs: 2000, now: fixed });
  assert.equal(result.capabilities.accountUsage, false);
  assert.equal(result.capabilities.threadUsage, false);
  assert.equal(result.accountUsage, null);
  assert.equal(result.errors.find((x) => x.method === 'account/usage/read').kind, 'malformed_response');
});

test('rate limit sanitizer retains bounded calibration metadata but omits detail IDs and descriptions', () => {
  const value = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { windowDurationMins: 300, usedPercent: 12.5, resetsAt: 123 },
      credits: { hasCredits: true, unlimited: false, balance: '12.3400', description: 'secret' },
      individualLimit: { limit: '50.00', used: '2.5', remainingPercent: 95, resetsAt: 456, detailId: 'private' },
      spendControlReached: false,
      rateLimitReachedType: 'workspace_member_usage_limit_reached'
    },
    rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'private-id', description: 'private description' }] }
  });
  const limit = value.limits[0];
  assert.deepEqual(limit.credits, { hasCredits: true, unlimited: false, balance: '12.3400' });
  assert.deepEqual(limit.individualLimit, { limit: '50.00', used: '2.5', remainingPercent: 95, resetsAt: 456 });
  assert.equal(limit.spendControlReached, false);
  assert.equal(limit.rateLimitReachedType, 'workspace_member_usage_limit_reached');
  assert.deepEqual(value.rateLimitResetCredits, { available: true, availableCount: 2 });
  assert.deepEqual(normalizeRateLimits({ rateLimits: { limitId: 'codex' }, rateLimitResetCredits: { availableCount: 0 } }).rateLimitResetCredits,
    { available: false, availableCount: 0 });
  assert.equal(JSON.stringify(value).includes('private'), false);

  assert.equal(normalizeRateLimitSnapshot({ credits: { hasCredits: false, unlimited: true, balance: '1e9' } }).credits.balance, null);
  assert.deepEqual(normalizeRateLimitSnapshot({
    limit_id: 'rollout-limit',
    primary: { window_minutes: 60, used_percent: 4, resets_at: 999 },
    credits: { has_credits: false, unlimited: true, balance: '0' }
  }), {
    limitId: 'rollout-limit', limitName: null, planType: null,
    windows: [{ slot: 'primary', durationMinutes: 60, usedPercent: 4, resetsAt: 999 }],
    credits: { hasCredits: false, unlimited: true, balance: '0' }, individualLimit: null,
    spendControlReached: null, rateLimitReachedType: null
  });
});

test('quota comparison matches limitId plus duration across slot reorder', () => {
  const before = snapshot('a', [
    { slot: 'primary', durationMinutes: 300, usedPercent: 10, resetsAt: 100 },
    { slot: 'secondary', durationMinutes: 10080, usedPercent: 20, resetsAt: 200 }
  ]);
  const after = snapshot('b', [
    { slot: 'secondary', durationMinutes: 300, usedPercent: 10, resetsAt: 100 },
    { slot: 'primary', durationMinutes: 10080, usedPercent: 20, resetsAt: 200 }
  ]);
  const result = compareSnapshots(before, after, fixed);
  assert.equal(result.comparableWindows, 2);
  assert.deepEqual(result.differences, []);
});

test('duplicate same-duration windows are explicitly ambiguous', () => {
  const duplicate = snapshot('a', [
    { slot: 'primary', durationMinutes: 300, usedPercent: 10, resetsAt: 100 },
    { slot: 'secondary', durationMinutes: 300, usedPercent: 10, resetsAt: 100 }
  ]);
  const comparison = compareSnapshots(duplicate, { ...structuredClone(duplicate), deviceLabel: 'b' }, fixed);
  assert.equal(comparison.comparableWindows, 0);
  assert.equal(comparison.ambiguousWindowIdentities.length, 1);
  assert.equal(comparison.differences[0].field, 'identityAmbiguous');

  const pending = { observationId: 'dup', startedAt: fixed, context: {}, quotaBefore: duplicate };
  const observation = finishObservation(pending, { ...structuredClone(duplicate), codexVersion: 'test' }, { total_tokens: 10 }, fixed);
  assert.equal(observation.quality.confidence, 'low');
  assert.equal(observation.quality.ambiguousWindowIdentities.length, 1);
  assert.ok(observation.quota.every((x) => x.matchStatus === 'ambiguous' && x.displayedPercentChange === null));
});

test('missing stable quota-window identity is unavailable rather than matched', () => {
  const unidentified = (slot) => ({ timestamp: fixed, deviceLabel: slot, planType: 'pro', quota: { limits: [{
    limitId: null, windows: [{ slot, durationMinutes: 300, usedPercent: 10, resetsAt: 100 }]
  }] } });
  const comparison = compareSnapshots(unidentified('primary'), unidentified('secondary'), fixed);
  assert.equal(comparison.comparableWindows, 0);
  assert.deepEqual(comparison.unavailableWindowIdentities, { left: 1, right: 1 });
  assert.match(comparison.assessment, /unavailable/);
  const observation = finishObservation({ observationId: 'unknown', startedAt: fixed, context: {}, quotaBefore: unidentified('primary') },
    { ...unidentified('secondary'), codexVersion: 'test' }, { total_tokens: 10 }, fixed);
  assert.equal(observation.quota[0].matchStatus, 'unavailable');
  assert.equal(observation.quota[0].displayedPercentChange, null);
  assert.equal(observation.quality.confidence, 'low');
});

test('malformed budget observation sequences remain unavailable and explicit', () => {
  const accounting = (observations) => ({
    strategies: { lineageAware: { rawCounters: { total_tokens: 10 } } },
    experimentalDimensions: { codexRolloutBudgetUnits: { lastUsageObservedValues: observations } }
  });
  for (const malformed of [[1, 'bad', 2], [1, -1], [1, NaN], [1, Infinity], 'not-an-array']) {
    const current = usageFrom(accounting(malformed));
    assert.equal(current.codex_rollout_budget_units_observations, null);
    assert.equal(current.codex_rollout_budget_units_observations_invalid, true);
    const interval = calibrationInterval(current, usageFrom(accounting([1])));
    assert.equal(interval.usage.codex_rollout_budget_units, null);
    assert.equal(interval.usage.codex_rollout_budget_units_observations, null);
    assert.ok(interval.regressedFields.includes('codex_rollout_budget_units_observation_sequence'));
  }
  const directMalformed = calibrationInterval(
    { total_tokens: 10, codex_rollout_budget_units_observations: [1, 'bad', 2] },
    { total_tokens: 5, codex_rollout_budget_units_observations: [1] });
  assert.equal(directMalformed.usage.codex_rollout_budget_units, null);
  assert.equal(directMalformed.usage.codex_rollout_budget_units_observations, null);
  assert.ok(directMalformed.regressedFields.includes('codex_rollout_budget_units_observation_sequence'));

  const observedZero = calibrationInterval(
    { total_tokens: 10, codex_rollout_budget_units_observations: [1, 0] },
    { total_tokens: 5, codex_rollout_budget_units_observations: [1] });
  assert.equal(observedZero.usage.codex_rollout_budget_units, 0);
  assert.deepEqual(observedZero.usage.codex_rollout_budget_units_observations, [0]);
  assert.equal(observedZero.regressedFields.includes('codex_rollout_budget_units_observation_sequence'), false);
});

test('calibration records budget units experimentally and lowers confidence for credit/reset confounders', () => {
  const interval = calibrationInterval(
    { input_tokens: 20, cached_input_tokens: 5, cache_write_input_tokens: 1, output_tokens: 4, reasoning_output_tokens: 2, total_tokens: 24, codex_rollout_budget_units: 3.75 },
    { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 12, codex_rollout_budget_units: 1.25 }
  );
  assert.equal(interval.usage.uncached_input_tokens, 7);
  assert.equal(interval.usage.codex_rollout_budget_units, null);
  const emptyObservations = calibrationInterval(
    { ...interval.usage, codex_rollout_budget_units_observations: [] },
    { ...interval.usage, codex_rollout_budget_units_observations: [] });
  assert.equal(emptyObservations.usage.codex_rollout_budget_units, null);
  assert.equal(emptyObservations.usage.codex_rollout_budget_units_observations, null);
  const unchangedObservations = calibrationInterval(
    { ...interval.usage, codex_rollout_budget_units_observations: [1.25] },
    { ...interval.usage, codex_rollout_budget_units_observations: [1.25] });
  assert.equal(unchangedObservations.usage.codex_rollout_budget_units, null);
  const invalidUncached = calibrationInterval(
    { input_tokens: 15, cached_input_tokens: 14, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 15 },
    { input_tokens: 10, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 10 });
  assert.equal(invalidUncached.usage.uncached_input_tokens, null);
  assert.ok(invalidUncached.regressedFields.includes('cached_input_tokens_exceeds_input_tokens'));
  const observedInterval = calibrationInterval(
    { ...interval.usage, codex_rollout_budget_units_observations: [1.25, 2.5, 0.75] },
    { ...interval.usage, codex_rollout_budget_units_observations: [1.25] }
  );
  assert.deepEqual(observedInterval.usage.codex_rollout_budget_units_observations, [2.5, 0.75]);
  assert.equal(observedInterval.usage.codex_rollout_budget_units, 3.25);

  const before = snapshot('calibration', [{ slot: 'primary', durationMinutes: 300, usedPercent: 10, resetsAt: 100 }], {
    credits: { hasCredits: true, unlimited: false, balance: '2.0' }
  });
  before.quota.rateLimitResetCredits = { available: true, availableCount: 1 };
  const after = snapshot('calibration', [{ slot: 'secondary', durationMinutes: 300, usedPercent: 12, resetsAt: 100 }], {
    credits: { hasCredits: true, unlimited: false, balance: '1.0' }
  });
  after.codexVersion = 'test';
  const pending = { observationId: 'budget', startedAt: '2026-08-29T11:59:00.000Z', context: {}, quotaBefore: before };
  const result = finishObservation(pending, after, observedInterval.usage, fixed);
  assert.equal(result.quota[0].matchStatus, 'matched');
  assert.equal(result.quota[0].beforeSlot, 'primary');
  assert.equal(result.quota[0].budgetUnitsPerDisplayedPoint, 1.625);
  assert.equal(result.quality.quotaConfounders.before.creditsActive, true);
  assert.equal(result.quality.quotaConfounders.before.resetCreditCount, 1);
  assert.equal(result.quality.confidence, 'low');
  assert.equal(result.estimator, null);
});
