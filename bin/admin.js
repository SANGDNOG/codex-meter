#!/usr/bin/env node
import os from 'node:os'; import path from 'node:path'; import { access } from 'node:fs/promises';
import { atomicWriteJson, hashToken, newToken, readJson } from '../lib/store.js';
import { zeroUsage } from '../lib/usage.js';

function fail(message) { console.error(message); process.exit(2); }
const [command, ...args] = process.argv.slice(2);
const stateFile = process.env.CODEX_METER_STATE || path.join(os.homedir(), '.codex-meter-server', 'state.json');
if (command === 'init') {
  try { await access(stateFile); fail(`refusing to overwrite existing state: ${stateFile}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const opts = Object.fromEntries(args.map((x) => { const i = x.indexOf('='); return i < 1 ? [x, true] : [x.slice(0, i), x.slice(i + 1)]; }));
  const users = String(opts['--users'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (users.length !== 3 || new Set(users).size !== 3) fail('init requires exactly 3 unique users: --users=alice,bob,carol');
  const observeOnly = opts['--observe-only'] === true; const quotaTokens = observeOnly ? null : Number(opts['--quota']); const resetPeriodMs = Number(opts['--reset-ms']); const maxConcurrentLeases = Number(opts['--max-leases'] || 1); const leaseTtlMs = Number(opts['--lease-ttl-ms'] || 120000);
  if (observeOnly && Object.hasOwn(opts, '--quota')) fail('--observe-only and --quota are mutually exclusive');
  if (![resetPeriodMs, maxConcurrentLeases, leaseTtlMs].every(Number.isSafeInteger) || [resetPeriodMs, maxConcurrentLeases, leaseTtlMs].some((n) => n <= 0) || (!observeOnly && (!Number.isSafeInteger(quotaTokens) || quotaTokens <= 0))) fail('positive integers required: --reset-ms, --max-leases, --lease-ttl-ms, and --quota unless --observe-only is set');
  if (maxConcurrentLeases !== 1) fail('--max-leases must be 1; overlapping scans can double-count one user');
  const adminToken = newToken(); const plaintext = {};
  const records = Object.fromEntries(users.map((id) => { const token = newToken(); plaintext[id] = token; return [id, { id, tokenHash: hashToken(token), enabled: true, used: zeroUsage() }]; }));
  await atomicWriteJson(stateFile, { version: 1, periodStart: Date.now(), config: { mode: observeOnly ? 'observe' : 'enforce', quotaTokens, resetPeriodMs, maxConcurrentLeases, leaseTtlMs }, adminTokenHash: hashToken(adminToken), users: records, leases: {} });
  // This is the only time plaintext tokens are emitted. Redirect securely and delete after distribution.
  console.log(JSON.stringify({ adminToken, users: plaintext }, null, 2));
} else if (command === 'set-enabled') {
  const [id, value] = args; if (!id || !['true', 'false'].includes(value)) fail('set-enabled USER true|false');
  const state = await readJson(stateFile); if (!state.users[id]) fail('unknown user'); state.users[id].enabled = value === 'true'; await atomicWriteJson(stateFile, state);
  console.log(`${id}: enabled=${value}`);
} else fail('usage: admin.js init --users=a,b,c (--quota=N | --observe-only) --reset-ms=N [--max-leases=N] [--lease-ttl-ms=N]\n       admin.js set-enabled USER true|false');
