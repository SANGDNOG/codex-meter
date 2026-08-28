import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanUsage, FIELDS, zeroUsage } from './usage.js';

export const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

export async function atomicWriteJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, filename);
}

export async function readJson(filename) { return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }

async function withFileLock(filename, operation) {
  const lock = `${filename}.lock`;
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30000) { await rm(lock, { recursive: true, force: true }); continue; } }
      catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      if (Date.now() >= deadline) throw new Error('state_lock_timeout');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

function secureEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export class MeterStore {
  constructor(filename, clock = () => Date.now()) { this.filename = filename; this.clock = clock; this.chain = Promise.resolve(); }
  async load() { return readJson(this.filename); }
  mutate(fn) {
    const operation = this.chain.then(() => withFileLock(this.filename, async () => {
      const state = await this.load();
      const result = await fn(state);
      await atomicWriteJson(this.filename, state);
      return result;
    }));
    this.chain = operation.catch(() => {});
    return operation;
  }
  authenticate(state, token) {
    const hash = hashToken(token || '');
    return Object.values(state.users).find((u) => secureEqualHex(u.tokenHash, hash));
  }
  maintain(state) {
    const now = this.clock();
    if (now - state.periodStart >= state.config.resetPeriodMs) {
      state.periodStart = now;
      for (const user of Object.values(state.users)) user.used = zeroUsage();
      // Keep each lease's absolute high-water mark so a client spanning the reset
      // contributes only post-reset deltas instead of recounting its entire run.
    }
    for (const [id, lease] of Object.entries(state.leases)) {
      if (lease.active && lease.expiresAt <= now) lease.active = false;
    }
  }
  start(token) { return this.mutate((s) => {
    this.maintain(s); const user = this.authenticate(s, token);
    const enforcing = s.config.mode !== 'observe';
    if (!user) return { status: 401, body: { error: 'bad_auth' } };
    if (!user.enabled) return { status: 403, body: { error: 'user_disabled' } };
    if (enforcing && user.used.total_tokens >= s.config.quotaTokens) return { status: 403, body: { error: 'quota_exhausted', used: user.used.total_tokens, quota: s.config.quotaTokens } };
    const active = Object.values(s.leases).filter((l) => l.userId === user.id && l.active).length;
    // One active wrapper per meter user prevents overlapping scans from double-counting.
    if (active >= 1) return { status: 409, body: { error: 'max_concurrent_leases' } };
    const id = crypto.randomUUID();
    s.leases[id] = { id, userId: user.id, active: true, startedAt: this.clock(), expiresAt: this.clock() + s.config.leaseTtlMs, usage: zeroUsage() };
    return { status: 201, body: { leaseId: id, mode: enforcing ? 'enforce' : 'observe', quota: s.config.quotaTokens, used: user.used.total_tokens, leaseTtlMs: s.config.leaseTtlMs } };
  }); }
  applyUpdate(s, token, leaseId, absolute, finishing = false) {
    this.maintain(s); const user = this.authenticate(s, token);
    if (!user) return { status: 401, body: { error: 'bad_auth' } };
    const lease = s.leases[leaseId];
    if (!lease || lease.userId !== user.id) return { status: 404, body: { error: 'lease_not_found' } };
    const expired = !lease.active;
    const incoming = cleanUsage(absolute);
    // Absolute monotonic per-lease counters make retries idempotent.
    const deltas = Object.fromEntries(FIELDS.map((key) => [key, Math.max(0, incoming[key] - lease.usage[key])]));
    if (FIELDS.some((key) => !Number.isSafeInteger(user.used[key] + deltas[key]))) return { status: 400, body: { error: 'usage_overflow' } };
    for (const key of FIELDS) {
      user.used[key] += deltas[key];
      lease.usage[key] = Math.max(lease.usage[key], incoming[key]);
    }
    const enforcing = s.config.mode !== 'observe';
    const crossed = enforcing && user.used.total_tokens >= s.config.quotaTokens;
    if (!expired && !finishing) lease.expiresAt = this.clock() + s.config.leaseTtlMs;
    if (finishing || crossed || !user.enabled) lease.active = false;
    const stop = expired || crossed || !user.enabled;
    return { status: 200, body: { stop, reason: !user.enabled ? 'user_disabled' : crossed ? 'quota_exhausted' : expired ? 'lease_expired' : null, used: user.used, mode: enforcing ? 'enforce' : 'observe', quota: s.config.quotaTokens } };
  }
  update(token, leaseId, absolute) { return this.mutate((s) => this.applyUpdate(s, token, leaseId, absolute, false)); }
  finish(token, leaseId, absolute) { return this.mutate((s) => this.applyUpdate(s, token, leaseId, absolute, true)); }
  usage(token) { return this.mutate((s) => { this.maintain(s); const user = this.authenticate(s, token); return user ? { status: 200, body: { user: user.id, used: user.used, mode: s.config.mode === 'observe' ? 'observe' : 'enforce', quota: s.config.quotaTokens, periodStart: s.periodStart, resetPeriodMs: s.config.resetPeriodMs, enabled: user.enabled } } : { status: 401, body: { error: 'bad_auth' } }; }); }
  admin(token) { return this.mutate((s) => {
    this.maintain(s);
    if (!secureEqualHex(s.adminTokenHash, hashToken(token || ''))) return { status: 401, body: { error: 'bad_admin_auth' } };
    return { status: 200, body: { periodStart: s.periodStart, config: s.config, users: Object.values(s.users).map(({ id, enabled, used }) => ({ id, enabled, used })) } };
  }); }
}
