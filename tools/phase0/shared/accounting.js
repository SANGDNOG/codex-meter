import { addTokens, metadata, regressedTokenFields, subtractTokens, TOKEN_FIELDS } from './core.js';

const empty = () => Object.fromEntries(TOKEN_FIELDS.map((key) => [key, null]));
function observations(file, field) { return file.events.map((event) => event[field]).filter(Boolean); }
function maximum(values) {
  if (!values.length) return empty();
  const out = empty();
  for (const key of TOKEN_FIELDS) {
    const observed = values.map((value) => value?.[key]);
    out[key] = observed.every(Number.isSafeInteger) ? Math.max(...observed) : null;
  }
  return out;
}
function first(values) { return values[0] || null; }
function identity(file) { return file.events.find((event) => event.sessionId)?.sessionId || file.fileId; }
function relation(file) {
  for (const event of file.events) {
    if (event.forkedFromId) return { type: 'fork', parentId: event.forkedFromId };
    if (event.subagentParentId) return { type: 'subagent', parentId: event.subagentParentId };
    if (event.parentThreadId) return { type: 'parent', parentId: event.parentThreadId };
  }
  return null;
}
export function analyzeAccounting(inspection, { now = new Date().toISOString() } = {}) {
  let naive = null; let sumLast = null; let lineage = null; const warningsLast = []; const ambiguous = [];
  const logical = new Map();
  for (const file of inspection.files || []) {
    naive = addTokens(naive, maximum(observations(file, 'totalUsage')));
    const lasts = observations(file, 'lastUsage');
    if (!lasts.length && observations(file, 'totalUsage').length) warningsLast.push(`${file.fileId}: no last_token_usage observations`);
    for (const value of lasts) sumLast = addTokens(sumLast, value);
    const key = identity(file); const entry = logical.get(key) || { id: key, files: [], relation: null, source: null };
    entry.files.push(file); entry.relation ||= relation(file); entry.source ||= file.events.find((event) => event.source)?.source || null; logical.set(key, entry);
  }
  const logicalIds = new Set(logical.keys());
  if ((inspection.scan?.droppedEvents ?? 0) > 0) ambiguous.push(`${inspection.scan.droppedEvents} events were omitted by the bounded retention limit`);
  const roots = [];
  for (const item of logical.values()) {
    const totals = item.files.flatMap((file) => observations(file, 'totalUsage'));
    for (const file of item.files) {
      const ordered = observations(file, 'totalUsage');
      for (let index = 1; index < ordered.length; index++) {
        const fields = regressedTokenFields(ordered[index], ordered[index - 1]);
        if (fields.length) ambiguous.push(`${item.id}: cumulative counters regressed in ${file.fileId}: ${fields.join(', ')}`);
      }
    }
    if (item.files.length > 1) ambiguous.push(`${item.id}: logical session spans multiple files with no reliable cross-file event ordering`);
    const highest = maximum(totals);
    if (item.relation) {
      if (!logicalIds.has(item.relation.parentId)) ambiguous.push(`${item.id}: explicit parent is outside the inspected data`);

      const baseline = first(totals);
      if (!baseline) ambiguous.push(`${item.id}: explicit ${item.relation.type} lineage has no cumulative baseline`);
      else lineage = addTokens(lineage, subtractTokens(highest, baseline));
    } else {
      roots.push(item.id);
      lineage = addTokens(lineage, highest);
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
      lineageAware: { rawCounters: lineage, totalTokens: lineage.total_tokens, quality: ambiguous.length ? 'ambiguous' : 'high', warnings: ambiguous }
    },
    differences: { naiveVsLineageRatio: denominator ? naive.total_tokens / denominator : null },
    ambiguous,
    tokenSemantics: 'reasoning_output_tokens is preserved as a dimension and is not added to output_tokens or total_tokens'
  };
}

export function buildLineage(inspection, { now = new Date().toISOString() } = {}) {
  const nodes = [];
  for (const file of inspection.files || []) {
    const totals = observations(file, 'totalUsage'); const rel = relation(file);
    nodes.push({ id: identity(file), relation: rel?.type || null, parentId: rel?.parentId || null,
      inheritedBaselineCandidate: rel && totals.length ? first(totals) : null,
      cumulativeTokens: totals.length ? maximum(totals) : null,
      source: file.events.find((event) => event.source)?.source || null });
  }
  const ids = new Set(nodes.map((node) => node.id)); const ambiguous = [];
  for (const node of nodes) if (node.parentId && !ids.has(node.parentId)) ambiguous.push(`${node.id}: observed parent is outside the inspected data`);
  return { ...metadata('lineage-inspector', now, inspection.codexVersion ?? null), nodes, ambiguous };
}
export function lineageText(lineage) {
  const children = new Map(); for (const node of lineage.nodes) { const key = node.parentId && lineage.nodes.some((x) => x.id === node.parentId) ? node.parentId : null; (children.get(key) || children.set(key, []).get(key)).push(node); }
  const lines = ['Codex Meter Phase 0 lineage (observed explicit metadata only)'];
  function show(node, depth, seen) {
    lines.push(`${'  '.repeat(depth)}- ${node.id} relation=${node.relation || 'none'} total=${node.cumulativeTokens?.total_tokens ?? 'unknown'} baseline=${node.inheritedBaselineCandidate?.total_tokens ?? 'none'}`);
    if (seen.has(node.id)) { lines.push(`${'  '.repeat(depth + 1)}cycle observed`); return; }
    const next = new Set(seen).add(node.id); for (const child of children.get(node.id) || []) show(child, depth + 1, next);
  }
  for (const node of children.get(null) || []) show(node, 0, new Set());
  for (const warning of lineage.ambiguous) lines.push(`WARNING: ${warning}`);
  return `${lines.join('\n')}\n`;
}
