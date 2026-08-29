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
    if (!this.child) return;
    this.child.stdin.end();
    if (this.child.exitCode == null) this.child.kill('SIGTERM');
    await new Promise((resolve) => { if (this.child.exitCode != null) resolve(); else { this.child.once('exit', resolve); setTimeout(resolve, 1000).unref(); } });
  }
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
  const duration = value.windowDurationMins ?? value.windowDurationMinutes ?? value.durationMinutes;
  return {
    slot,
    durationMinutes: Number.isSafeInteger(duration) ? duration : null,
    usedPercent: typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent) ? value.usedPercent : null,
    resetsAt: safeTimestamp(value.resetsAt)
  };
}
function snapshot(value, fallbackId = null) {
  if (!value || typeof value !== 'object') return null;
  const windows = [];
  for (const slot of ['primary', 'secondary']) { const window = windowValue(slot, value[slot]); if (window) windows.push(window); }
  if (Array.isArray(value.windows)) for (let i = 0; i < value.windows.length; i++) {
    const window = windowValue(safeAtom(value.windows[i]?.slot) || `window-${i}`, value.windows[i]); if (window) windows.push(window);
  }
  const limitId = safeAtom(value.limitId) || safeAtom(fallbackId);
  const limitName = safeAtom(value.limitName); const planType = safeAtom(value.planType);
  if (!limitId && !limitName && !planType && windows.length === 0) return null;
  return { limitId, limitName, planType, windows };
}
export function normalizeRateLimits(result) {
  const limits = [];
  const byId = result?.rateLimitsByLimitId;
  if (byId && typeof byId === 'object' && !Array.isArray(byId)) {
    for (const id of Object.keys(byId).sort()) { const item = snapshot(byId[id], id); if (item) limits.push(item); }
  }
  const legacy = snapshot(result?.rateLimits ?? result);
  if (legacy && !limits.some((item) => item.limitId === legacy.limitId && JSON.stringify(item.windows) === JSON.stringify(legacy.windows))) limits.push(legacy);
  return { limits };
}
export function normalizeAccount(result) {
  const account = result?.account;
  if (!account || typeof account !== 'object') return null;
  return { type: safeAtom(account.type), planType: safeAtom(account.planType) };
}
export function normalizeAccountUsage(result) {
  if (!result || typeof result !== 'object') return null;
  const allowed = {};
  for (const key of ['planType', 'usedPercent', 'resetsAt', 'windowDurationMins']) {
    const value = result[key]; if (typeof value === 'number' || safeAtom(value)) allowed[key] = value;
  }
  return Object.keys(allowed).length ? allowed : { available: true, fieldsRecognized: false };
}
