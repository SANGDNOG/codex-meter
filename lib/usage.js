import { opendir, open } from 'node:fs/promises';
import path from 'node:path';

export const FIELDS = Object.freeze([
  'input_tokens', 'cached_input_tokens', 'output_tokens',
  'reasoning_output_tokens', 'total_tokens'
]);

export function zeroUsage() { return Object.fromEntries(FIELDS.map((k) => [k, 0])); }
export function cleanUsage(value = {}) {
  const out = zeroUsage();
  for (const key of FIELDS) {
    const n = value[key];
    if (Number.isSafeInteger(n) && n >= 0) out[key] = n;
  }
  return out;
}
export function addUsage(a, b) {
  return Object.fromEntries(FIELDS.map((k) => [k, (a[k] || 0) + (b[k] || 0)]));
}

/** Parse only token_count records. No other event field is retained or returned. */
export function parseTokenCountLine(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') return null;
  const info = record.payload.info;
  if (!info || typeof info !== 'object') return null;
  const usage = info.total_token_usage ?? info.last_token_usage;
  if (!usage || typeof usage !== 'object') return null;
  return cleanUsage(usage);
}

export async function latestUsageInFile(filename) {
  // Streaming by line keeps prompts/responses out of retained application state.
  const handle = await open(filename, 'r');
  let carry = '';
  let latest = zeroUsage();
  try {
    for await (const chunk of handle.createReadStream({ encoding: 'utf8' })) {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) latest = parseTokenCountLine(line) ?? latest;
    }
    if (carry) latest = parseTokenCountLine(carry) ?? latest;
  } finally { await handle.close().catch(() => {}); }
  return latest;
}

async function jsonlFiles(root, output) {
  let directory;
  try { directory = await opendir(root); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for await (const entry of directory) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await jsonlFiles(full, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(full);
  }
}

export async function scanSessions(sessionsRoot) {
  const files = [];
  await jsonlFiles(sessionsRoot, files);
  files.sort();
  const snapshot = new Map();
  for (const file of files) {
    try { snapshot.set(file, await latestUsageInFile(file)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return snapshot;
}

/** Positive deltas only; a new/truncated session contributes its current total. */
export function snapshotDelta(previous, current) {
  let total = zeroUsage();
  for (const [file, now] of current) {
    const before = previous.get(file);
    const delta = zeroUsage();
    for (const key of FIELDS) {
      delta[key] = before && now[key] >= before[key] ? now[key] - before[key] : now[key];
    }
    total = addUsage(total, delta);
  }
  return total;
}
