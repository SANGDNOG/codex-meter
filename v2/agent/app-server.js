import { spawn as nodeSpawn } from 'node:child_process';
import { AGENT_VERSION } from './config.js';

export const QUOTA_ERROR_KINDS = Object.freeze(['codex_not_found', 'app_server_timeout', 'app_server_unavailable', 'not_authenticated', 'malformed_rate_limits', 'ambiguous_limits']);
const PLAN_TYPES = new Set(['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu']);
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_WINDOWS = 32;

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function atom(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;
}
function plan(value) { const normalized = typeof value === 'string' ? value.toLowerCase() : null; return PLAN_TYPES.has(normalized) ? normalized : null; }
function resetTime(value) {
  let time;
  if (typeof value === 'string' && value.length <= 40) time = Date.parse(value);
  else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) time = value < 10_000_000_000 ? value * 1000 : value;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function windowValue(value, slot, limitId) {
  if (!object(value)) return null;
  const duration = value.windowDurationMins ?? value.windowDurationMinutes ?? value.durationMinutes;
  const used = value.usedPercent ?? value.used_percent;
  const normalizedId = atom(value.limitId ?? value.limit_id) ?? limitId;
  if (!normalizedId || !Number.isSafeInteger(duration) || duration <= 0 || typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  return { limitId: normalizedId, durationMinutes: duration, usedPercent: used, resetsAt: resetTime(value.resetsAt ?? value.resets_at), slot: atom(slot, 32) };
}

export function normalizeQuota(rateLimitsResult, observedAt = new Date().toISOString()) {
  if (!object(rateLimitsResult)) return { observedAt, status: 'unavailable', errorKind: 'malformed_rate_limits', planType: null, windows: [] };
  const sources = [];
  const hasById = Object.hasOwn(rateLimitsResult, 'rateLimitsByLimitId');
  const byId = rateLimitsResult.rateLimitsByLimitId;
  if (hasById && byId != null && !object(byId)) return { observedAt, status: 'unavailable', errorKind: 'malformed_rate_limits', planType: null, windows: [] };
  const byIdKeys = object(byId) ? Object.keys(byId).sort() : [];
  if (byIdKeys.length) {
    for (const key of byIdKeys) {
      if (!object(byId[key])) return { observedAt, status: 'unavailable', errorKind: 'malformed_rate_limits', planType: null, windows: [] };
      sources.push([byId[key], atom(key)]);
    }
  } else if (object(rateLimitsResult.rateLimits)) sources.push([rateLimitsResult.rateLimits, null]);
  if (!sources.length && (rateLimitsResult.primary || rateLimitsResult.secondary || rateLimitsResult.windows)) sources.push([rateLimitsResult, null]);
  const windows = [];
  let planType = null;
  for (const [source, fallbackId] of sources) {
    if (!object(source)) continue;
    const sourceWindowStart = windows.length;
    const limitId = atom(source.limitId ?? source.limit_id) ?? fallbackId;
    planType ??= plan(source.planType ?? source.plan_type);
    for (const slot of ['primary', 'secondary']) {
      if (source[slot] !== undefined && source[slot] !== null) {
        const item = windowValue(source[slot], slot, limitId);
        if (item) windows.push(item); else return { observedAt, status: 'unavailable', errorKind: 'malformed_rate_limits', planType, windows: [] };
      }
    }
    if (source.windows !== undefined && source.windows !== null) {
      if (!Array.isArray(source.windows) || source.windows.length > MAX_WINDOWS) return { observedAt, status: 'unavailable', errorKind: 'malformed_rate_limits', planType, windows: [] };
      for (const raw of source.windows) {
        const item = windowValue(raw, raw?.slot, limitId);
        if (item) windows.push(item); else return { observedAt, status: 'unavailable', errorKind: 'malformed_rate_limits', planType, windows: [] };
      }
    }
    if (windows.length === sourceWindowStart) return { observedAt, status: 'unavailable', errorKind: 'malformed_rate_limits', planType, windows: [] };
  }
  if (!windows.length || windows.length > MAX_WINDOWS) return { observedAt, status: 'unavailable', errorKind: 'malformed_rate_limits', planType, windows: [] };
  const identities = windows.map((item) => `${item.limitId}\u0000${item.durationMinutes}`);
  if (new Set(identities).size !== identities.length) return { observedAt, status: 'ambiguous', errorKind: 'ambiguous_limits', planType, windows: [] };
  windows.sort((a, b) => a.limitId.localeCompare(b.limitId) || a.durationMinutes - b.durationMinutes);
  return { observedAt, status: 'available', planType, windows };
}

class SafeAppServerError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}
function safeError(error, command) {
  if (error instanceof SafeAppServerError) return error;
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return new SafeAppServerError('codex_not_found');
  return new SafeAppServerError('app_server_unavailable');
}

export class ReadOnlyAppServerClient {
  constructor({ command = 'codex', codexHome = null, timeoutMs = 10_000, maxLineBytes = MAX_LINE_BYTES, spawnImpl = nodeSpawn } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('invalid App Server timeout');
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1024 || maxLineBytes > 8 * 1024 * 1024) throw new Error('invalid App Server line bound');
    this.command = command; this.codexHome = codexHome; this.timeoutMs = timeoutMs; this.maxLineBytes = maxLineBytes; this.spawn = spawnImpl; this.nextId = 1; this.pending = new Map(); this.buffer = Buffer.alloc(0); this.discarding = false;
  }
  async start() {
    if (this.child) throw new Error('App Server already started');
    try {
      this.child = this.spawn(this.command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
        env: this.codexHome ? { ...process.env, CODEX_HOME: this.codexHome } : process.env });
      this.child.stdin?.on('error', (error) => this.#rejectAll(safeError(error, this.command)));
      this.child.stderr?.resume?.(); // Drain, but never retain or log diagnostics.
      this.child.stdout?.on('data', (chunk) => this.#consume(chunk));
      this.child.once('error', (error) => this.#rejectAll(safeError(error, this.command)));
      this.child.once('exit', () => this.#rejectAll(new SafeAppServerError('app_server_unavailable')));
      await this.#request('initialize', { clientInfo: { name: 'codex-meter-agent', title: 'Codex Meter Agent', version: AGENT_VERSION }, capabilities: null });
      this.#write({ method: 'initialized', params: null });
    } catch (error) { throw safeError(error, this.command); }
  }
  async isAuthenticated() {
    const result = await this.#request('account/read', { refreshToken: false });
    return object(result) && object(result.account);
  }
  readRateLimits() { return this.#request('account/rateLimits/read', null); }
  #write(message) {
    const input = this.child?.stdin;
    if (!input?.writable || input.destroyed || input.writableEnded) throw new SafeAppServerError('app_server_unavailable');
    input.write(`${JSON.stringify(message)}\n`, (error) => { if (error) this.#rejectAll(safeError(error, this.command)); });
  }
  #request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new SafeAppServerError('app_server_timeout')); }, this.timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try { this.#write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(String(id)); reject(safeError(error, this.command)); }
    });
  }
  #consume(chunk) {
    let input = chunk;
    while (input.length) {
      if (this.discarding) { const newline = input.indexOf(10); if (newline < 0) return; input = input.subarray(newline + 1); this.discarding = false; continue; }
      const newline = input.indexOf(10); const piece = newline < 0 ? input : input.subarray(0, newline);
      if (this.buffer.length + piece.length > this.maxLineBytes) { this.buffer = Buffer.alloc(0); if (newline < 0) { this.discarding = true; return; } input = input.subarray(newline + 1); continue; }
      this.buffer = Buffer.concat([this.buffer, piece]);
      if (newline < 0) return;
      const line = this.buffer; this.buffer = Buffer.alloc(0); input = input.subarray(newline + 1); this.#line(line);
    }
  }
  #line(line) {
    let message; try { message = JSON.parse(line.toString('utf8')); } catch { return; }
    if (!object(message) || !Object.hasOwn(message, 'id')) return;
    const pending = this.pending.get(String(message.id)); if (!pending) return;
    this.pending.delete(String(message.id)); clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) pending.reject(new SafeAppServerError('app_server_unavailable')); else pending.resolve(message.result);
  }
  #rejectAll(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  async close() {
    if (!this.child) return;
    const child = this.child; this.child = null;
    const waitForExit = () => new Promise((resolve) => {
      if (child.exitCode != null || !child.once) return resolve(true);
      let settled=false; const finish=(value)=>{if(settled)return;settled=true;resolve(value);};
      child.once('exit',()=>finish(true)); setTimeout(()=>finish(false),1000).unref();
    });
    try { child.stdin?.end?.(); if (child.exitCode == null) child.kill?.('SIGTERM'); } catch { /* best effort */ }
    if (!await waitForExit()) {
      try { if (child.exitCode == null) child.kill?.('SIGKILL'); } catch { /* best effort */ }
      await waitForExit();
    }
  }
}

export class QuotaReporter {
  constructor(options = {}) { this.options = options; this.clock = options.clock ?? Date.now; }
  async observe() {
    const observedAt = new Date(this.clock()).toISOString(); const client = new ReadOnlyAppServerClient(this.options);
    const scoped = Object.hasOwn(this.options, 'accountId') ? { accountId: this.options.accountId } : {};
    try {
      await client.start();
      if (!await client.isAuthenticated()) return { ...scoped, observedAt, status: 'unavailable', errorKind: 'not_authenticated', planType: null, windows: [] };
      return { ...scoped, ...normalizeQuota(await client.readRateLimits(), observedAt) };
    } catch (error) {
      return { ...scoped, observedAt, status: 'unavailable', errorKind: safeError(error, this.options.command ?? 'codex').kind, planType: null, windows: [] };
    } finally { await client.close(); }
  }
}
