#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runAppServerProbe } from './app-server-probe.js';
import { metadata } from './shared/core.js';
import { childPath, safeFilenameAtom } from './shared/sanitize.js';
import { assertNoUnknown, option, printJson, writeJson } from './shared/output.js';

export function compareSnapshots(left, right, now = new Date().toISOString()) {
  const key = (limit, window) => typeof limit.limitId === 'string' && limit.limitId.length > 0
    && Number.isSafeInteger(window.durationMinutes) && window.durationMinutes >= 0
    ? `${limit.limitId}\u0000${window.durationMinutes}` : null;
  const flatten = (snapshot) => {
    const groups = new Map(); const unavailable = [];
    for (const limit of snapshot.limits || []) for (const window of limit.windows || []) {
      const id = key(limit, window);
      const observed = { limitId: limit.limitId, limitName: limit.limitName, planType: limit.planType, ...window };
      if (id == null) { unavailable.push(observed); continue; }
      const values = groups.get(id) || []; values.push(observed); groups.set(id, values);
    }
    return { groups, unavailable };
  };
  const leftWindows = flatten(left.quota); const rightWindows = flatten(right.quota);
  const a = leftWindows.groups; const b = rightWindows.groups; const differences = [];
  const ambiguousWindowIdentities = [...new Set([...a.keys(), ...b.keys()])].filter((id) => (a.get(id)?.length || 0) > 1 || (b.get(id)?.length || 0) > 1).sort();
  const unavailableWindowIdentities = { left: leftWindows.unavailable.length, right: rightWindows.unavailable.length };
  for (let index = 0; index < leftWindows.unavailable.length; index++) differences.push({ key: `left-unidentified-${index}`, field: 'identityUnavailable', left: true, right: null });
  for (let index = 0; index < rightWindows.unavailable.length; index++) differences.push({ key: `right-unidentified-${index}`, field: 'identityUnavailable', left: null, right: true });
  if ((left.planType ?? null) !== (right.planType ?? null)) differences.push({ key: 'snapshot', field: 'planType', left: left.planType ?? null, right: right.planType ?? null });
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(id) || !b.has(id)) differences.push({ key: id, field: 'presence', left: a.has(id), right: b.has(id) });
    else if (ambiguousWindowIdentities.includes(id)) differences.push({ key: id, field: 'identityAmbiguous', left: a.get(id).length, right: b.get(id).length });
    else for (const field of ['limitName', 'planType', 'usedPercent', 'resetsAt']) if (a.get(id)[0][field] !== b.get(id)[0][field]) differences.push({ key: id, field, left: a.get(id)[0][field] ?? null, right: b.get(id)[0][field] ?? null });
  }
  const comparableWindows = [...a.keys()].filter((id) => b.has(id) && !ambiguousWindowIdentities.includes(id)).length;
  const unavailableIdentity = unavailableWindowIdentities.left > 0 || unavailableWindowIdentities.right > 0;
  const assessment = ambiguousWindowIdentities.length || unavailableIdentity ? 'ambiguous or unavailable quota-window identities; quota scope cannot be inferred from this pair'
    : differences.length ? 'snapshots differ; quota scope cannot be inferred from this pair'
    : comparableWindows === 0 ? 'insufficient comparable rate-limit windows; quota scope cannot be inferred from this pair'
      : 'observations match; this is consistent with, but does not prove, a shared quota scope';
  return { ...metadata('quota-comparison', now, null), devices: [left.deviceLabel, right.deviceLabel], timestamps: [left.timestamp, right.timestamp], comparableWindows, ambiguousWindowIdentities, unavailableWindowIdentities, differences, assessment };
}
export async function takeSnapshot(deviceLabel, options = {}) {
  const label = safeFilenameAtom(deviceLabel, 80); if (!label) throw new Error('device label must start with a letter or digit and contain only letters, digits, dot, plus, at, underscore, or hyphen');
  const probe = await runAppServerProbe(options);
  return { ...metadata('quota-snapshot', probe.timestamp, probe.codexVersion), deviceLabel: label, planType: probe.account?.planType ?? null, quota: probe.rateLimits, capabilities: probe.capabilities, errors: probe.errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2);
    const compareAt = args.indexOf('--compare');
    if (compareAt >= 0) {
      if (compareAt !== 0 || args.length !== 3) throw new Error('--compare requires exactly two JSON files');
      const names = args.slice(compareAt + 1);
      printJson(compareSnapshots(...await Promise.all(names.map(async (name) => JSON.parse(await readFile(name, 'utf8'))))));
    } else {
      assertNoUnknown(args, ['--device-label', '--output']);
      const label = option(args, '--device-label'); if (!label) throw new Error('--device-label is required');
      const result = await takeSnapshot(label); const output = option(args, '--output') || childPath('phase0-output', `${result.deviceLabel}-quota.json`); await writeJson(output, result); printJson(result);
    }
  } catch (error) { console.error(`phase0 quota snapshot: ${error.message}`); process.exitCode = 2; }
}
