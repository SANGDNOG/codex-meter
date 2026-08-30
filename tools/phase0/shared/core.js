import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const SCHEMA_VERSION = 1;
export const PROBE_VERSION = '0.1.0';
export const TOKEN_FIELDS = Object.freeze([
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'
]);
const execFileAsync = promisify(execFile);

export function metadata(probe, timestamp = new Date().toISOString(), codexVersion = null) {
  return { schemaVersion: SCHEMA_VERSION, probeVersion: PROBE_VERSION, probe, timestamp, codexVersion };
}
export async function getCodexVersion(command = process.env.CODEX_PHASE0_CODEX || 'codex') {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], { timeout: 10000, maxBuffer: 16 * 1024 });
    return (stdout || stderr).trim().slice(0, 100) || null;
  } catch { return null; }
}
export function cleanTokens(value) {
  const out = Object.fromEntries(TOKEN_FIELDS.map((key) => [key, null]));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of TOKEN_FIELDS) if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
  // Upstream uses Option<serde_json::Number>. It is provider workload, not a token counter,
  // and is deliberately excluded from TOKEN_FIELDS and all token arithmetic below.
  const budget = value.codex_rollout_budget_units;
  if (typeof budget === 'number' && Number.isFinite(budget) && budget >= 0) out.codex_rollout_budget_units = budget;
  return out;
}
export function addTokens(a, b) {
  if (a == null) return cleanTokens(b);
  if (b == null) return cleanTokens(a);
  return Object.fromEntries(TOKEN_FIELDS.map((key) => {
    const left = Number.isSafeInteger(a?.[key]) ? a[key] : null;
    const right = Number.isSafeInteger(b?.[key]) ? b[key] : null;
    return [key, left == null || right == null ? null : left + right];
  }));
}
export function subtractTokens(current, baseline) {
  return Object.fromEntries(TOKEN_FIELDS.map((key) => {
    let value;
    if (current?.[key] == null || baseline?.[key] == null) value = null;
    else value = Math.max(0, current[key] - baseline[key]);
    return [key, value];
  }));
}
export function regressedTokenFields(current, baseline) {
  return TOKEN_FIELDS.filter((key) => Number.isSafeInteger(baseline?.[key]) && (!Number.isSafeInteger(current?.[key]) || current[key] < baseline[key]));
}
