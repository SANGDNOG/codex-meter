#!/usr/bin/env node
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { takeSnapshot } from './quota-snapshot.js';
import { metadata, regressedTokenFields, subtractTokens, TOKEN_FIELDS } from './shared/core.js';
import { inspectRollouts } from './shared/rollout.js';
import { analyzeAccounting } from './shared/accounting.js';

import { childPath, safeAtom, safeFilenameAtom } from './shared/sanitize.js';
import { assertNoUnknown, option, printJson, writeJson } from './shared/output.js';

function windows(snapshot) {
  return (snapshot.quota?.limits || []).flatMap((limit) => (limit.windows || []).map((window) => ({ limitId: limit.limitId, planType: limit.planType, ...window })));
}
function budgetObservationSequence(value) {
  if (value == null) return { observations: null, invalid: false };
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0)) {
    return { observations: null, invalid: true };
  }
  return { observations: [...value], invalid: false };
}
export function usageFrom(value) {
  const raw = value?.strategies?.lineageAware?.rawCounters ?? value?.usage ?? null;
  if (!raw) return null;
  const usage = Object.fromEntries(TOKEN_FIELDS.map((key) => [key, Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : null]));
  const budget = raw.codex_rollout_budget_units ?? value?.strategies?.lineageAware?.codexRolloutBudgetUnits ?? value?.codexRolloutBudgetUnits;
  usage.codex_rollout_budget_units = typeof budget === 'number' && Number.isFinite(budget) && budget >= 0 ? budget : null;
  const sequence = budgetObservationSequence(value?.experimentalDimensions?.codexRolloutBudgetUnits?.lastUsageObservedValues);
  usage.codex_rollout_budget_units_observations = sequence.observations;
  usage.codex_rollout_budget_units_observations_invalid = sequence.invalid;
  usage.uncached_input_tokens = usage.input_tokens != null && usage.cached_input_tokens != null && usage.cached_input_tokens <= usage.input_tokens
    ? usage.input_tokens - usage.cached_input_tokens : null;
  return usage;
}
function withUncached(usage) {
  if (!usage) return null;
  return { ...usage, uncached_input_tokens: usage.input_tokens != null && usage.cached_input_tokens != null && usage.cached_input_tokens <= usage.input_tokens
    ? usage.input_tokens - usage.cached_input_tokens : null };
}
export function calibrationInterval(current, baseline) {
  const regressedFields = regressedTokenFields(current, baseline);
  const usage = subtractTokens(current, baseline);
  for (const key of regressedFields) usage[key] = null;
  if (usage.input_tokens != null && usage.cached_input_tokens != null && usage.cached_input_tokens > usage.input_tokens) {
    regressedFields.push('cached_input_tokens_exceeds_input_tokens');
  }
  const currentSequence = budgetObservationSequence(current?.codex_rollout_budget_units_observations);
  const baselineSequence = budgetObservationSequence(baseline?.codex_rollout_budget_units_observations);
  const currentObservations = currentSequence.observations;
  const baselineObservations = baselineSequence.observations;
  const malformedSequence = currentSequence.invalid || baselineSequence.invalid
    || current?.codex_rollout_budget_units_observations_invalid === true
    || baseline?.codex_rollout_budget_units_observations_invalid === true;
  const prefixMatches = !malformedSequence && Array.isArray(currentObservations) && Array.isArray(baselineObservations)
    && baselineObservations.length <= currentObservations.length
    && baselineObservations.every((value, index) => value === currentObservations[index]);
  if (prefixMatches && currentObservations.length > baselineObservations.length) {
    usage.codex_rollout_budget_units_observations = currentObservations.slice(baselineObservations.length);
    usage.codex_rollout_budget_units = usage.codex_rollout_budget_units_observations.reduce((sum, value) => sum + value, 0);
  } else {
    usage.codex_rollout_budget_units = null;
    usage.codex_rollout_budget_units_observations = null;
    if (malformedSequence || (!prefixMatches && ((Array.isArray(currentObservations) && currentObservations.length)
      || (Array.isArray(baselineObservations) && baselineObservations.length)))) regressedFields.push('codex_rollout_budget_units_observation_sequence');
  }
  return { usage: withUncached(usage), regressedFields };
}
async function localAccounting(args) {
  const explicitSessions = option(args, '--sessions');
  const inspection = await inspectRollouts({
    root: explicitSessions || undefined,
    home: explicitSessions ? undefined : option(args, '--codex-home') || undefined,
    secretFile: option(args, '--secret-file') || undefined
  });
  return analyzeAccounting(inspection);
}
export function finishObservation(pending, after, usage, endedAt, localUsageQuality = 'unassessed', regressedFields = []) {
  const key = (x) => typeof x.limitId === 'string' && x.limitId.length > 0
    && Number.isSafeInteger(x.durationMinutes) && x.durationMinutes >= 0 ? `${x.limitId}\u0000${x.durationMinutes}` : null;
  const group = (items) => {
    const grouped = new Map(); const unavailable = [];
    for (const item of items) {
      const id = key(item); if (id == null) { unavailable.push(item); continue; }
      const list = grouped.get(id) || []; list.push(item); grouped.set(id, list);
    }
    return { grouped, unavailable };
  };
  const beforeWindows = group(windows(pending.quotaBefore)); const afterWindows = group(windows(after));
  const beforeByKey = beforeWindows.grouped; const afterByKey = afterWindows.grouped;
  const ambiguousWindowIdentities = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])]
    .filter((id) => (beforeByKey.get(id)?.length || 0) > 1 || (afterByKey.get(id)?.length || 0) > 1).sort();
  if (beforeWindows.unavailable.length) ambiguousWindowIdentities.push(`unavailable-before:${beforeWindows.unavailable.length}`);
  if (afterWindows.unavailable.length) ambiguousWindowIdentities.push(`unavailable-after:${afterWindows.unavailable.length}`);
  const quota = windows(after).map((current) => {
    const currentKey = key(current); const matches = currentKey == null ? null : beforeByKey.get(currentKey);
    const previous = matches?.length === 1 && afterByKey.get(currentKey)?.length === 1 ? matches[0] : null;
    const change = previous && typeof previous.usedPercent === 'number' && typeof current.usedPercent === 'number' ? current.usedPercent - previous.usedPercent : null;
    return { limitId: current.limitId, slot: current.slot, beforeSlot: previous?.slot ?? null, windowDurationMins: current.durationMinutes,
      matchStatus: currentKey == null ? 'unavailable' : ambiguousWindowIdentities.includes(currentKey) ? 'ambiguous' : previous ? 'matched' : 'unmatched',
      beforeUsedPercent: previous?.usedPercent ?? null, afterUsedPercent: current.usedPercent,
      beforeResetAt: previous?.resetsAt ?? null, afterResetAt: current.resetsAt,
      displayedPercentChange: change,
      experimentalTokensPerDisplayedPoint: change > 0 && usage?.total_tokens != null ? usage.total_tokens / change : null,
      budgetUnitsPerDisplayedPoint: change > 0 && typeof usage?.codex_rollout_budget_units === 'number' ? usage.codex_rollout_budget_units / change : null,
      budgetUnitsPerDisplayedPointClassification: 'experimental' };
  });
  const resetDetected = quota.some((x) => x.beforeResetAt != null && x.afterResetAt != null && x.beforeResetAt !== x.afterResetAt);
  const beforeKeys = new Set(beforeByKey.keys()); const afterKeys = new Set(afterByKey.keys());
  const quotaScopeChanged = beforeKeys.size !== afterKeys.size || [...beforeKeys].some((id) => !afterKeys.has(id));
  const confounderState = (snapshot) => ({
    creditsActive: (snapshot.quota?.limits || []).some((limit) => limit.credits?.hasCredits === true || limit.credits?.unlimited === true),
    resetCreditCount: snapshot.quota?.rateLimitResetCredits?.availableCount ?? null,
    individualLimitActive: (snapshot.quota?.limits || []).some((limit) => limit.individualLimit != null),
    spendControlReached: (snapshot.quota?.limits || []).some((limit) => limit.spendControlReached === true),
    rateLimitReached: (snapshot.quota?.limits || []).some((limit) => limit.rateLimitReachedType != null)
  });
  const quotaConfounders = { before: confounderState(pending.quotaBefore), after: confounderState(after) };
  const confounderDetected = Object.values(quotaConfounders.before).some(Boolean) || Object.values(quotaConfounders.after).some(Boolean)
    || JSON.stringify(quotaConfounders.before) !== JSON.stringify(quotaConfounders.after);
  return { ...metadata('calibration-observation', endedAt, after.codexVersion), observationId: pending.observationId, startedAt: pending.startedAt, endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(pending.startedAt)), planType: after.planType, quota, usage,
    context: pending.context,
    quality: { resetDetected, quotaScopeChanged, ambiguousWindowIdentities, quotaConfounders, overlappingLocalSessions: 'not_observed_by_tool', localUsageQuality, regressedTokenFields: regressedFields,
      confidence: resetDetected || quotaScopeChanged || ambiguousWindowIdentities.length || confounderDetected || localUsageQuality === 'ambiguous' || regressedFields.length ? 'low' : 'unassessed',
      notes: ['Displayed usedPercent is quantized: unchanged does not prove zero cost, and a one-point change is not an exact continuous percentage.',
        'budgetUnitsPerDisplayedPoint is experimental provider-reported workload correlation, not account quota attribution.',
        ...(regressedFields.length ? [`Cumulative token counters regressed across the calibration boundary: ${regressedFields.join(', ')}; affected interval counters are unknown.`] : [])] },
    estimator: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2); const action = args.shift(); const observationId = args.shift();
    assertNoUnknown(args, ['--output-dir', '--usage', '--model', '--reasoning-effort', '--service-tier', '--turn-count', '--sessions', '--codex-home', '--secret-file']);
    const id = safeFilenameAtom(observationId, 80); if (!id) throw new Error('usage: calibration-recorder.js start|finish SAFE_ID [options]');
    const outputDir = path.resolve(option(args, '--output-dir', 'phase0-output/calibration')); const pendingFile = childPath(outputDir, `${id}.pending.json`);
    if (action === 'start') {
      const startedAt = new Date().toISOString(); const quotaBefore = await takeSnapshot('calibration');
      const turnCountText = option(args, '--turn-count'); const turnCount = turnCountText == null ? null : Number(turnCountText);
      if (turnCount != null && (!Number.isSafeInteger(turnCount) || turnCount < 0)) throw new Error('--turn-count must be a nonnegative integer');
      const context = { model: safeAtom(option(args, '--model')), reasoningEffort: safeAtom(option(args, '--reasoning-effort')), serviceTier: safeAtom(option(args, '--service-tier')), turnCount };
      const baseline = await localAccounting(args);
      const pending = { ...metadata('calibration-start', startedAt, quotaBefore.codexVersion), observationId: id, startedAt, quotaBefore, context,
        localUsageBaseline: usageFrom(baseline),
        localUsageBaselineQuality: baseline.strategies.lineageAware.quality };
      await writeJson(pendingFile, pending); printJson(pending);
    } else if (action === 'finish') {
      const pending = JSON.parse(await readFile(pendingFile, 'utf8')); const after = await takeSnapshot('calibration');
      const usageFile = option(args, '--usage');
      const current = usageFile ? { usage: usageFrom(JSON.parse(await readFile(usageFile, 'utf8'))), quality: 'externally_supplied' }
        : await localAccounting(args).then((value) => ({ usage: usageFrom(value), quality: value.strategies.lineageAware.quality }));
      const interval = calibrationInterval(current.usage, pending.localUsageBaseline);
      const quality = pending.localUsageBaselineQuality === 'ambiguous' || current.quality === 'ambiguous' || interval.regressedFields.length ? 'ambiguous' : current.quality;
      const result = finishObservation(pending, after, interval.usage, new Date().toISOString(), quality, interval.regressedFields); await writeJson(childPath(outputDir, `${id}.json`), result); await unlink(pendingFile); printJson(result);
    } else throw new Error('first argument must be start or finish');
  } catch (error) { console.error(`phase0 calibration recorder: ${error.message}`); process.exitCode = 2; }
}
