import { addTokens, metadata, regressedTokenFields, subtractTokens, TOKEN_FIELDS } from './core.js';

const empty = () => Object.fromEntries(TOKEN_FIELDS.map((key) => [key, null]));
function observations(file, field) { return (file.events || []).map((event) => event[field]).filter(Boolean); }
function maximum(values) {
  if (!values.length) return empty();
  const out = empty();
  for (const key of TOKEN_FIELDS) {
    const observed = values.map((value) => value?.[key]);
    out[key] = observed.every(Number.isSafeInteger) ? Math.max(...observed) : null;
  }
  return out;
}
function firstUsageEvent(files) {
  for (const file of files) for (const event of file.events || []) if (event.totalUsage) return event;
  return null;
}
function identity(file) {
  const event = (file.events || []).find((item) => item.threadId || item.sessionId);
  return event?.threadId || event?.sessionId || file.fileId;
}
function relation(file) {
  for (const event of file.events || []) {
    if (event.forkedFromId) return { type: 'fork', parentId: event.forkedFromId, cutoff: event.forkedFromOrdinalExclusive, cutoffKind: event.forkCutoffKind, historyBase: event.historyBase };
    if (event.sourceRelation?.parentId) return { type: 'subagent', parentId: event.sourceRelation.parentId, cutoff: event.subagentHistoryStartOrdinal, historyBase: event.historyBase };
    if (event.parentThreadId) return { type: 'parent', parentId: event.parentThreadId, cutoff: event.subagentHistoryStartOrdinal, historyBase: event.historyBase };
  }
  return null;
}
function tokenEqual(left, right) {
  if (!left || !right) return false;
  const known = TOKEN_FIELDS.filter((key) => left[key] != null);
  return known.length > 0 && known.every((key) => right[key] != null && left[key] === right[key]);
}
function logicalEntries(inspection) {
  const logical = new Map();
  for (const file of inspection.files || []) {
    const key = identity(file); const entry = logical.get(key) || { id: key, files: [], relation: null, source: null };
    entry.files.push(file); entry.relation ||= relation(file); entry.source ||= (file.events || []).find((event) => event.source)?.source || null;
    logical.set(key, entry);
  }
  return logical;
}
function parentStateAtFork(parent, relation) {
  const events = parent.files.flatMap((file) => (file.events || []).filter((event) => event.totalUsage));
  if (!events.length) return null;
  const cutoff = relation.cutoff ?? relation.historyBase?.endOrdinalExclusive;
  if (cutoff != null) {
    const before = events.filter((event) => event.rolloutOrdinal < cutoff).map((event) => event.totalUsage);
    if (before.length) return maximum(before);
    if (relation.cutoffKind !== 'legacy') return null;
  }
  // Legacy rollouts did not persist ordinals. A sole/latest observed cumulative value is evidence,
  // but confirmation still additionally requires explicit lineage/cutoff and a zero child delta.
  return maximum(events.map((event) => event.totalUsage));
}
function baselineAssessment(item, logical) {
  const candidateEvent = firstUsageEvent(item.files); const candidate = candidateEvent?.totalUsage || null;
  const evidence = [];
  if (!item.relation) return { candidate: null, status: 'not_applicable', evidence };
  evidence.push(`explicit_${item.relation.type}_relation`);
  const parent = logical.get(item.relation.parentId);
  if (!parent) return { candidate, status: 'missing_parent', evidence };
  if (item.relation.cutoff == null && item.relation.historyBase?.endOrdinalExclusive == null) {
    evidence.push('fork_cutoff_unavailable');
    return { candidate, status: 'ambiguous', evidence };
  }
  evidence.push('fork_cutoff_observed');
  const parentAtFork = parentStateAtFork(parent, item.relation);
  if (!candidate || !parentAtFork || !tokenEqual(candidate, parentAtFork)) {
    evidence.push('candidate_does_not_match_observed_parent_cumulative');
    return { candidate, status: 'ambiguous', evidence };
  }
  evidence.push('candidate_matches_observed_parent_cumulative_at_fork');
  if (!candidateEvent.initialLastUsageZero) {
    evidence.push('initial_last_usage_not_observed_zero');
    return { candidate, status: 'ambiguous', evidence };
  }
  evidence.push('initial_last_usage_zero');
  return { candidate, status: 'confirmed', evidence };
}

export function analyzeAccounting(inspection, { now = new Date().toISOString() } = {}) {
  let naive = null; let sumLast = null; let lineage = null; const warningsLast = []; const ambiguous = [];
  const cumulativeBudgetValues = []; const lastUsageBudgetValues = []; const logical = logicalEntries(inspection);
  for (const file of inspection.files || []) {
    const totals = observations(file, 'totalUsage');
    naive = addTokens(naive, maximum(totals));
    const lasts = observations(file, 'lastUsage');
    for (const usage of totals) if (typeof usage.codex_rollout_budget_units === 'number') cumulativeBudgetValues.push(usage.codex_rollout_budget_units);
    for (const usage of lasts) if (typeof usage.codex_rollout_budget_units === 'number') lastUsageBudgetValues.push(usage.codex_rollout_budget_units);
    if (!lasts.length && totals.length) warningsLast.push(`${file.fileId}: no last_token_usage observations`);
    for (const value of lasts) sumLast = addTokens(sumLast, value);
  }
  if ((inspection.scan?.droppedEvents ?? 0) > 0) ambiguous.push(`${inspection.scan.droppedEvents} events were omitted by the bounded retention limit`);
  if (inspection.scanCompleteness === 'incomplete_compressed' || inspection.scan?.scanCompleteness === 'incomplete_compressed') {
    ambiguous.push('compressed-only rollouts were detected but not decoded; accounting is incomplete');
  }
  const roots = []; const baselines = [];
  for (const item of logical.values()) {
    const totals = item.files.flatMap((file) => observations(file, 'totalUsage'));
    for (const file of item.files) {
      const ordered = observations(file, 'totalUsage');
      for (let index = 1; index < ordered.length; index++) {
        const fields = regressedTokenFields(ordered[index], ordered[index - 1]);
        if (fields.length) ambiguous.push(`${item.id}: cumulative counters regressed in ${file.fileId}: ${fields.join(', ')}`);
      }
    }
    const assessment = baselineAssessment(item, logical);
    baselines.push({ id: item.id, inheritedBaselineCandidate: assessment.candidate, baselineStatus: assessment.status, baselineEvidence: assessment.evidence });
    if (item.files.length > 1) {
      const rolloutIds = new Set(item.files.map((file) => file.rolloutId).filter(Boolean));
      const inherited = item.files.some((file) => (file.events || []).some((event) => event.historyBase));
      ambiguous.push(`${item.id}: logical thread spans multiple physical rollout files; exact ${inherited || rolloutIds.size > 1 ? 'revert/inherited-history' : 'cross-file'} reconstruction is unavailable`);
    }
    const highest = maximum(totals);
    if (item.relation) {
      if (assessment.status === 'confirmed') lineage = addTokens(lineage, subtractTokens(highest, assessment.candidate));
      else {
        lineage = addTokens(lineage, highest); // Never subtract an unconfirmed candidate.
        if (assessment.status === 'missing_parent') ambiguous.push(`${item.id}: explicit parent is outside the inspected data`);
        else ambiguous.push(`${item.id}: inherited baseline candidate is not confirmed`);
      }
    } else {
      roots.push(item.id); lineage = addTokens(lineage, highest);
      if (/fork|subagent|child|resume/i.test(item.source || '')) ambiguous.push(`${item.id}: source suggests lineage but no explicit parent identifier was observed`);
    }
  }
  if (roots.length > 1) ambiguous.push(`multiple unconnected session roots (${roots.length}) were observed; combined lineage cannot be established safely`);
  naive ??= empty(); sumLast ??= empty(); lineage ??= empty();
  if (!logical.size) ambiguous.push('no cumulative token observations were available');
  else if (lineage.total_tokens == null) ambiguous.push('lineage accounting is incomplete because total_tokens is unavailable');
  const denominator = lineage.total_tokens;
  return {
    ...metadata('accounting-analyzer', now, inspection.codexVersion ?? null),
    sessionFamily: logical.size === 1 ? [...logical.keys()][0] : null,
    strategies: {
      naiveCumulative: { rawCounters: naive, totalTokens: naive.total_tokens, interpretation: 'maximum cumulative value from every file' },
      sumLastUsage: { rawCounters: sumLast, totalTokens: sumLast.total_tokens, warnings: warningsLast },
      lineageAware: { rawCounters: lineage, totalTokens: lineage.total_tokens, quality: ambiguous.length ? 'ambiguous' : 'high', warnings: ambiguous, baselines }
    },
    experimentalDimensions: {
      codexRolloutBudgetUnits: {
        cumulativeObservedValues: cumulativeBudgetValues,
        lastUsageObservedValues: lastUsageBudgetValues,
        intervalArithmeticSource: 'last_token_usage_only',
        arithmeticIncludedInTokenTotals: false,
        attribution: 'provider_reported_experimental'
      }
    },
    differences: { naiveVsLineageRatio: denominator ? naive.total_tokens / denominator : null },
    ambiguous,
    tokenSemantics: 'reasoning_output_tokens and codex_rollout_budget_units are separate dimensions and are not added to output_tokens or total_tokens'
  };
}

export function buildLineage(inspection, { now = new Date().toISOString() } = {}) {
  const logical = logicalEntries(inspection); const nodes = [];
  for (const item of logical.values()) {
    const totals = item.files.flatMap((file) => observations(file, 'totalUsage')); const assessment = baselineAssessment(item, logical);
    nodes.push({ id: item.id, relation: item.relation?.type || null, parentId: item.relation?.parentId || null,
      inheritedBaselineCandidate: assessment.candidate, baselineStatus: assessment.status, baselineEvidence: assessment.evidence,
      cumulativeTokens: totals.length ? maximum(totals) : null, source: item.source,
      physicalRolloutIds: [...new Set(item.files.map((file) => file.rolloutId).filter(Boolean))],
      historyBases: item.files.flatMap((file) => (file.events || []).map((event) => event.historyBase).filter(Boolean)) });
  }
  const ids = new Set(nodes.map((node) => node.id)); const ambiguous = [];
  for (const node of nodes) {
    if (node.parentId && !ids.has(node.parentId)) ambiguous.push(`${node.id}: observed parent is outside the inspected data`);
    if (node.baselineStatus === 'ambiguous' || node.baselineStatus === 'missing_parent') ambiguous.push(`${node.id}: baseline ${node.baselineStatus}`);
    if (node.physicalRolloutIds.length > 1 || node.historyBases.length) ambiguous.push(`${node.id}: physical/history-base lineage requires revert-aware interpretation`);
  }
  if (inspection.scanCompleteness === 'incomplete_compressed' || inspection.scan?.scanCompleteness === 'incomplete_compressed') ambiguous.push('compressed-only rollout history was not decoded');
  return { ...metadata('lineage-inspector', now, inspection.codexVersion ?? null), nodes, ambiguous };
}
export function lineageText(lineage) {
  const children = new Map(); for (const node of lineage.nodes) { const key = node.parentId && lineage.nodes.some((x) => x.id === node.parentId) ? node.parentId : null; (children.get(key) || children.set(key, []).get(key)).push(node); }
  const lines = ['Codex Meter Phase 0 lineage (observed explicit metadata only)'];
  function show(node, depth, seen) {
    lines.push(`${'  '.repeat(depth)}- ${node.id} relation=${node.relation || 'none'} total=${node.cumulativeTokens?.total_tokens ?? 'unknown'} baseline=${node.inheritedBaselineCandidate?.total_tokens ?? 'none'} status=${node.baselineStatus}`);
    if (seen.has(node.id)) { lines.push(`${'  '.repeat(depth + 1)}cycle observed`); return; }
    const next = new Set(seen).add(node.id); for (const child of children.get(node.id) || []) show(child, depth + 1, next);
  }
  for (const node of children.get(null) || []) show(node, 0, new Set());
  for (const warning of lineage.ambiguous) lines.push(`WARNING: ${warning}`);
  return `${lines.join('\n')}\n`;
}
