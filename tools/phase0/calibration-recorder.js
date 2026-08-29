#!/usr/bin/env node
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { takeSnapshot } from './quota-snapshot.js';
import { metadata, regressedTokenFields, subtractTokens, TOKEN_FIELDS } from './shared/core.js';
import { inspectRollouts } from './shared/rollout.js';
import { analyzeAccounting } from './shared/accounting.js';
import { sessionsRoot } from './shared/paths.js';
import { childPath, safeAtom, safeFilenameAtom } from './shared/sanitize.js';
import { assertNoUnknown, option, printJson, writeJson } from './shared/output.js';

function windows(snapshot) {
  return (snapshot.quota?.limits || []).flatMap((limit) => (limit.windows || []).map((window) => ({ limitId: limit.limitId, planType: limit.planType, ...window })));
}
function usageFrom(value) {
  const raw = value?.strategies?.lineageAware?.rawCounters ?? value?.usage ?? null;
  if (!raw) return null;
  const usage = Object.fromEntries(TOKEN_FIELDS.map((key) => [key, Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : null]));
  usage.uncached_input_tokens = usage.input_tokens != null && usage.cached_input_tokens != null
    ? Math.max(0, usage.input_tokens - usage.cached_input_tokens) : null;
  return usage;
}
function withUncached(usage) {
  if (!usage) return null;
  return { ...usage, uncached_input_tokens: usage.input_tokens != null && usage.cached_input_tokens != null
    ? Math.max(0, usage.input_tokens - usage.cached_input_tokens) : null };
}
export function calibrationInterval(current, baseline) {
  const regressedFields = regressedTokenFields(current, baseline);
  const usage = subtractTokens(current, baseline);
  for (const key of regressedFields) usage[key] = null;
  return { usage: withUncached(usage), regressedFields };
}
async function localAccounting(args) {
  const inspection = await inspectRollouts({
    root: sessionsRoot(option(args, '--sessions'), option(args, '--codex-home')),
    secretFile: option(args, '--secret-file') || undefined
  });
  return analyzeAccounting(inspection);
}
export function finishObservation(pending, after, usage, endedAt, localUsageQuality = 'unassessed', regressedFields = []) {
  const beforeByKey = new Map(windows(pending.quotaBefore).map((x) => [`${x.limitId}\u0000${x.slot}\u0000${x.durationMinutes}`, x]));
  const quota = windows(after).map((current) => {
    const previous = beforeByKey.get(`${current.limitId}\u0000${current.slot}\u0000${current.durationMinutes}`);
    const change = previous && typeof previous.usedPercent === 'number' && typeof current.usedPercent === 'number' ? current.usedPercent - previous.usedPercent : null;
    return { limitId: current.limitId, slot: current.slot, windowDurationMins: current.durationMinutes, beforeUsedPercent: previous?.usedPercent ?? null, afterUsedPercent: current.usedPercent,
      beforeResetAt: previous?.resetsAt ?? null, afterResetAt: current.resetsAt,
      displayedPercentChange: change,
      experimentalTokensPerDisplayedPoint: change > 0 && usage?.total_tokens != null ? usage.total_tokens / change : null };
  });
  const resetDetected = quota.some((x) => x.beforeResetAt != null && x.afterResetAt != null && x.beforeResetAt !== x.afterResetAt);
  const beforeKeys = new Set(beforeByKey.keys()); const afterKeys = new Set(windows(after).map((x) => `${x.limitId}\u0000${x.slot}\u0000${x.durationMinutes}`));
  const quotaScopeChanged = beforeKeys.size !== afterKeys.size || [...beforeKeys].some((key) => !afterKeys.has(key));
  return { ...metadata('calibration-observation', endedAt, after.codexVersion), observationId: pending.observationId, startedAt: pending.startedAt, endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(pending.startedAt)), planType: after.planType, quota, usage,
    context: pending.context,
    quality: { resetDetected, quotaScopeChanged, overlappingLocalSessions: 'not_observed_by_tool', localUsageQuality, regressedTokenFields: regressedFields,
      confidence: resetDetected || quotaScopeChanged || localUsageQuality === 'ambiguous' || regressedFields.length ? 'low' : 'unassessed',
      notes: ['Displayed usedPercent is quantized: unchanged does not prove zero cost, and a one-point change is not an exact continuous percentage.',
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
        localUsageBaseline: baseline.strategies.lineageAware.rawCounters,
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
