import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { safeAtom, safeTimestamp } from './sanitize.js';

const ALLOWED = new Set(['initialize', 'account/read', 'account/rateLimits/read', 'account/usage/read']);

export class AppServerClient {
  constructor({ command = process.env.CODEX_PHASE0_CODEX || 'codex', timeoutMs = 10000 } = {}) {
    this.command = command; this.timeoutMs = timeoutMs; this.nextId = 1; this.pending = new Map(); this.stderrBytes = 0;
  }
  async start() {
    this.child = spawn(this.command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', (chunk) => { this.stderrBytes += chunk.length; }); // Never retain or print server diagnostics.
    this.child.once('error', (error) => this.rejectAll(error));
    this.child.once('exit', () => this.rejectAll(new Error('App Server exited')));
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.length > 8 * 1024 * 1024) return;
      let message; try { message = JSON.parse(line); } catch { return; }
      if (!Object.hasOwn(message, 'id')) return; // Notifications are deliberately ignored.
      const pending = this.pending.get(String(message.id)); if (!pending) return;
      this.pending.delete(String(message.id)); clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(safeError(message.error)), { rpcError: message.error }));
      else pending.resolve(message.result);
    });
    await this.request('initialize', { clientInfo: { name: 'codex-meter-phase0', title: 'Codex Meter Phase 0', version: '0.1.0' }, capabilities: null });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: null })}\n`);
  }
  request(method, params = null) {
    if (!ALLOWED.has(method)) throw new Error(`refusing non-allowlisted App Server method: ${method}`);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`${method} timed out`)); }, this.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  rejectAll(error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  async close() {
    if (!this.child) return { exited: true, forced: false };
    const child = this.child; this.child = null;
    child.stdin.end();
    if (child.exitCode != null || child.signalCode != null) return { exited: true, forced: false };
    child.kill('SIGTERM');
    if (await waitForExit(child, 1000)) return { exited: true, forced: false };
    child.kill('SIGKILL');
    const exited = await waitForExit(child, 1000);
    if (!exited) throw new Error('App Server process exit could not be confirmed');
    return { exited: true, forced: true };
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false; let timer;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); child.removeListener('exit', onExit); resolve(value); };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(child.exitCode != null || child.signalCode != null), timeoutMs);
  });
}
function safeError(error) {
  const code = Number.isSafeInteger(error?.code) ? error.code : null;
  const message = code === -32601 ? 'method_not_found' : 'request_failed';
  return code == null ? message : `${message} (${code})`;
}
export function classifyError(error) {
  const code = Number.isSafeInteger(error?.rpcError?.code) ? error.rpcError.code : null;
  const raw = typeof error?.rpcError?.message === 'string' ? error.rpcError.message : typeof error?.message === 'string' ? error.message : '';
  const unsupported = code === -32601 || /method.not.found|unsupported/i.test(raw);
  return { code, kind: unsupported ? 'unsupported' : 'request_failed', message: unsupported ? 'method_not_found' : 'request_failed' };
}

function windowValue(slot, value) {
  if (!value || typeof value !== 'object') return null;
  const duration = value.windowDurationMins ?? value.windowDurationMinutes ?? value.window_minutes ?? value.windowMinutes ?? value.window_duration_mins ?? value.durationMinutes;
  const usedPercent = value.usedPercent ?? value.used_percent;
  return {
    slot,
    durationMinutes: Number.isSafeInteger(duration) ? duration : null,
    usedPercent: typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? usedPercent : null,
    resetsAt: safeTimestamp(value.resetsAt ?? value.resets_at)
  };
}
function decimalString(value) {
  return typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}
function creditsValue(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    hasCredits: typeof (value.hasCredits ?? value.has_credits) === 'boolean' ? (value.hasCredits ?? value.has_credits) : null,
    unlimited: typeof value.unlimited === 'boolean' ? value.unlimited : null,
    balance: decimalString(value.balance)
  };
}
function individualLimitValue(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    limit: decimalString(value.limit),
    used: decimalString(value.used),
    remainingPercent: Number.isSafeInteger(value.remainingPercent ?? value.remaining_percent) && (value.remainingPercent ?? value.remaining_percent) >= 0 && (value.remainingPercent ?? value.remaining_percent) <= 100 ? (value.remainingPercent ?? value.remaining_percent) : null,
    resetsAt: safeTimestamp(value.resetsAt ?? value.resets_at)
  };
}

// Shared by the App Server probe and rollout token_count parser. Keep this a
// structural allowlist: provider descriptions and reset-credit detail IDs are
// deliberately excluded.
export function normalizeRateLimitSnapshot(value, fallbackId = null) {
  if (!value || typeof value !== 'object') return null;
  const windows = [];
  for (const slot of ['primary', 'secondary']) { const window = windowValue(slot, value[slot]); if (window) windows.push(window); }
  if (Array.isArray(value.windows)) for (let i = 0; i < value.windows.length; i++) {
    const window = windowValue(safeAtom(value.windows[i]?.slot) || `window-${i}`, value.windows[i]); if (window) windows.push(window);
  }
  const limitId = safeAtom(value.limitId ?? value.limit_id) || safeAtom(fallbackId);
  const limitName = safeAtom(value.limitName ?? value.limit_name); const planType = safeAtom(value.planType ?? value.plan_type);
  const credits = creditsValue(value.credits);
  const individualLimit = individualLimitValue(value.individualLimit ?? value.individual_limit);
  const spendValue = value.spendControlReached ?? value.spend_control_reached;
  const spendControlReached = typeof spendValue === 'boolean' ? spendValue : null;
  const rateLimitReachedType = safeAtom(value.rateLimitReachedType ?? value.rate_limit_reached_type);
  if (!limitId && !limitName && !planType && windows.length === 0 && !credits && !individualLimit && spendControlReached == null && !rateLimitReachedType) return null;
  return { limitId, limitName, planType, windows, credits, individualLimit, spendControlReached, rateLimitReachedType };
}
export function normalizeRateLimits(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const limits = [];
  const byId = result?.rateLimitsByLimitId;
  if (byId && typeof byId === 'object' && !Array.isArray(byId)) {
    for (const id of Object.keys(byId).sort()) { const item = normalizeRateLimitSnapshot(byId[id], id); if (item) limits.push(item); }
  }
  const hasEnvelope = Object.hasOwn(result, 'rateLimits') || Object.hasOwn(result, 'rateLimitsByLimitId') || Object.hasOwn(result, 'rateLimitResetCredits');
  const legacy = normalizeRateLimitSnapshot(hasEnvelope ? result.rateLimits : result);
  if (legacy && !limits.some((item) => item.limitId === legacy.limitId && JSON.stringify(item.windows) === JSON.stringify(legacy.windows))) limits.push(legacy);
  const reset = result.rateLimitResetCredits;
  let rateLimitResetCredits = null;
  if (reset && typeof reset === 'object' && !Array.isArray(reset)) {
    const count = Number.isSafeInteger(reset.availableCount) && reset.availableCount >= 0 ? reset.availableCount : null;
    rateLimitResetCredits = {
      available: count == null ? null : count > 0,
      availableCount: count
    };
  }
  const structurallyValidEnvelope = (result.rateLimits && typeof result.rateLimits === 'object' && !Array.isArray(result.rateLimits))
    || (byId && typeof byId === 'object' && !Array.isArray(byId))
    || (reset && typeof reset === 'object' && !Array.isArray(reset));
  if (!legacy && limits.length === 0 && !rateLimitResetCredits && !structurallyValidEnvelope) return null;
  return { limits, rateLimitResetCredits };
}
export function normalizeAccount(result) {
  const account = result?.account;
  if (!account || typeof account !== 'object') return null;
  return { type: safeAtom(account.type), planType: safeAtom(account.planType) };
}
export function normalizeAccountUsage(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !result.summary || typeof result.summary !== 'object' || Array.isArray(result.summary)) return null;
  const summary = {};
  const summaryFields = ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'];
  let fieldsRecognized = false;
  for (const key of summaryFields) {
    if (!Object.hasOwn(result.summary, key)) continue;
    fieldsRecognized = true;
    const value = result.summary[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) return null;
    summary[key] = value;
  }
  let dailyUsageBuckets;
  if (Object.hasOwn(result, 'dailyUsageBuckets')) {
    fieldsRecognized = true;
    if (result.dailyUsageBuckets === null) dailyUsageBuckets = null;
    else if (!Array.isArray(result.dailyUsageBuckets)) return null;
    else {
      if (result.dailyUsageBuckets.some((bucket) => !bucket || typeof bucket !== 'object' || Array.isArray(bucket) || typeof bucket.startDate !== 'string' || bucket.startDate.length > 40 || !Number.isSafeInteger(bucket.tokens) || bucket.tokens < 0)) return null;
      dailyUsageBuckets = result.dailyUsageBuckets.map((bucket) => ({ startDate: bucket.startDate, tokens: bucket.tokens }));
    }
  }
  const threadUsagePresent = Object.hasOwn(result, 'threadUsage');
  if (threadUsagePresent && result.threadUsage !== null && (!result.threadUsage || typeof result.threadUsage !== 'object' || Array.isArray(result.threadUsage))) return null;
  if (threadUsagePresent && result.threadUsage !== null) {
    const usage = result.threadUsage; const usd = usage.estimatedUsageUsdMicros;
    if (typeof usage.threadId !== 'string' || usage.threadId.length === 0 || usage.threadId.length > 160
      || !Number.isSafeInteger(usage.estimatedUsageCreditsMicros) || usage.estimatedUsageCreditsMicros < 0
      || (usd !== null && (!Number.isSafeInteger(usd) || usd < 0)) || !Array.isArray(usage.groups)) return null;
  }
  if (threadUsagePresent) fieldsRecognized = true;
  return {
    available: true,
    fieldsRecognized,
    summary,
    ...(Object.hasOwn(result, 'dailyUsageBuckets') ? { dailyUsageBuckets } : {}),
    threadUsage: { present: threadUsagePresent, available: threadUsagePresent && result.threadUsage != null }
  };
}
