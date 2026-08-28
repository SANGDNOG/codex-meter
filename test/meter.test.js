import test from 'node:test'; import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process';
import { latestUsageInFile, scanSessions, snapshotDelta, zeroUsage } from '../lib/usage.js';
import { atomicWriteJson, hashToken, MeterStore } from '../lib/store.js';
import { acquireClientLock, isPermanentMeterError, replaySpool, spoolUpdate } from '../lib/client.js'; import { commandSpec } from '../lib/command.js';
import { createMeterServer } from '../lib/server.js';

const fixture = path.join(import.meta.dirname, 'fixtures', 'session.jsonl');
const usage = (total, input = total) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total });
async function temp() { return mkdtemp(path.join(os.tmpdir(), 'codex-meter-test-')); }
async function makeStore({ quota = 100, ttl = 1000, max = 1, mode = 'enforce' } = {}) {
  const dir = await temp(); const file = path.join(dir, 'state.json'); let now = 10000; const token = 'meter-user-token';
  await atomicWriteJson(file, { version: 1, periodStart: now, config: { mode, quotaTokens: mode === 'observe' ? null : quota, resetPeriodMs: 100000, maxConcurrentLeases: max, leaseTtlMs: ttl }, adminTokenHash: hashToken('admin'), users: { alice: { id: 'alice', tokenHash: hashToken(token), enabled: true, used: zeroUsage() } }, leases: {} });
  return { store: new MeterStore(file, () => now), token, file, tick: (n) => { now += n; } };
}

test('parser fixture retains only latest token_count totals', async () => {
  assert.deepEqual(await latestUsageInFile(fixture), { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 17 });
});

test('baseline produces only subsequent positive session delta', async () => {
  const dir = await temp(); const sessions = path.join(dir, 'sessions', '2026'); await mkdir(sessions, { recursive: true }); const file = path.join(sessions, 'a.jsonl');
  await writeFile(file, '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"total_tokens":10}}}}\n'); const baseline = await scanSessions(path.join(dir, 'sessions'));
  await writeFile(file, '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"total_tokens":10}}}}\n{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":16,"total_tokens":16}}}}\n');
  assert.deepEqual(snapshotDelta(baseline, await scanSessions(path.join(dir, 'sessions'))), usage(6, 6));
});

test('duplicate absolute update is idempotent', async () => {
  const { store, token } = await makeStore(); const lease = (await store.start(token)).body.leaseId;
  await store.update(token, lease, usage(12)); await store.update(token, lease, usage(12));
  assert.equal((await store.usage(token)).body.used.total_tokens, 12);
});

test('bad auth is rejected', async () => { const { store } = await makeStore(); assert.equal((await store.start('wrong')).status, 401); });

test('start is denied when quota is exhausted', async () => {
  const { store, token } = await makeStore({ quota: 10 }); const id = (await store.start(token)).body.leaseId; await store.update(token, id, usage(10));
  const denied = await store.start(token); assert.equal(denied.status, 403); assert.equal(denied.body.error, 'quota_exhausted');
});

test('quota crossing tells running lease to stop', async () => {
  const { store, token } = await makeStore({ quota: 10 }); const id = (await store.start(token)).body.leaseId; const result = await store.update(token, id, usage(11));
  assert.equal(result.body.stop, true); assert.equal(result.body.reason, 'quota_exhausted');
});

test('observe-only mode records usage without quota denial or stop', async () => {
  const { store, token } = await makeStore({ mode: 'observe' }); const id = (await store.start(token)).body.leaseId;
  const update = await store.update(token, id, usage(1000000));
  assert.equal(update.body.stop, false); assert.equal(update.body.mode, 'observe'); assert.equal(update.body.quota, null);
  await store.finish(token, id, usage(1000000));
  const replacement = await store.start(token); assert.equal(replacement.status, 201); assert.equal(replacement.body.mode, 'observe');
});

test('legacy state without a mode remains enforcing', async () => {
  const ctx = await makeStore({ quota: 10 }); const state = JSON.parse(await readFile(ctx.file, 'utf8')); delete state.config.mode; await atomicWriteJson(ctx.file, state);
  const id = (await ctx.store.start(ctx.token)).body.leaseId; const update = await ctx.store.update(ctx.token, id, usage(10));
  assert.equal(update.body.stop, true); assert.equal(update.body.mode, 'enforce');
});

test('admin init creates an observe-only state without a token quota', async () => {
  const dir = await temp(); const stateFile = path.join(dir, 'state.json'); const admin = path.join(import.meta.dirname, '..', 'bin', 'admin.js');
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [admin, 'init', '--users=alice,bob,carol', '--observe-only', '--reset-ms=2592000000'], { env: { ...process.env, CODEX_METER_STATE: stateFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (x) => { stderr += x; }); child.on('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr); const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.config.mode, 'observe'); assert.equal(state.config.quotaTokens, null);
});

test('admin init rejects observe-only combined with a quota', async () => {
  const dir = await temp(); const stateFile = path.join(dir, 'state.json'); const admin = path.join(import.meta.dirname, '..', 'bin', 'admin.js');
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [admin, 'init', '--users=alice,bob,carol', '--observe-only', '--quota=100', '--reset-ms=2592000000'], { env: { ...process.env, CODEX_METER_STATE: stateFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (x) => { stderr += x; }); child.on('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2); assert.match(result.stderr, /mutually exclusive/);
});

test('stale lease expires and permits a replacement', async () => {
  const ctx = await makeStore({ ttl: 50 }); const stale = (await ctx.store.start(ctx.token)).body.leaseId; ctx.tick(51);
  assert.equal((await ctx.store.start(ctx.token)).status, 201);
  const late = await ctx.store.update(ctx.token, stale, usage(3)); assert.equal(late.body.stop, true); assert.equal(late.body.reason, 'lease_expired');
});

test('period reset keeps lease high-water mark and counts only new delta', async () => {
  const ctx = await makeStore(); const id = (await ctx.store.start(ctx.token)).body.leaseId;
  await ctx.store.update(ctx.token, id, usage(40)); ctx.tick(100001);
  await ctx.store.update(ctx.token, id, usage(45));
  assert.equal((await ctx.store.usage(ctx.token)).body.used.total_tokens, 5);
});

test('spool replay retains failures then removes successful absolute update', async () => {
  const dir = path.join(await temp(), 'spool'); const item = { leaseId: 'lease-1', usage: usage(7), finish: false }; await spoolUpdate(dir, item);
  assert.equal(await replaySpool(dir, async () => { throw new Error('offline'); }), 0);
  let received; assert.equal(await replaySpool(dir, async (x) => { received = x; }), 1); assert.deepEqual(received, item);
  assert.equal(await replaySpool(dir, async () => {}), 0);
});

test('command arguments are passed literally without a shell', () => {
  const args = ['--model', 'x & calc.exe', '$(touch /tmp/pwn)', 'quote"value', '%PATH%']; const spec = commandSpec(args, { platform: 'win32', command: 'C:\\safe\\codex.exe' });
  assert.equal(spec.options.shell, false); assert.deepEqual(spec.args, args); assert.equal(spec.command, 'C:\\safe\\codex.exe'); assert.throws(() => commandSpec(['ok\ncalc'], { command: 'codex' }), /invalid/);
});

test('Unix launcher resolves an installation symlink before locating the app', async () => {
  const root = await temp(); const link = path.join(root, 'codex-meter'); const launcher = path.join(import.meta.dirname, '..', 'clients', 'unix', 'codex-meter');
  await symlink(launcher, link);
  const result = await new Promise((resolve) => {
    const child = spawn(link, [], { env: { ...process.env, CODEX_METER_HOME: path.join(root, 'missing') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (x) => { stderr += x; }); child.on('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 78, result.stderr); assert.match(result.stderr, /Missing\/invalid/); assert.doesNotMatch(result.stderr, /Cannot find module/);
});

test('state stores only token hashes', async () => {
  const { file, token } = await makeStore(); const text = await readFile(file, 'utf8'); assert.equal(text.includes(token), false); assert.match(text, /tokenHash/);
});

test('client lock rejects overlapping wrappers and releases cleanly', async () => {
  const home = path.join(await temp(), 'meter'); const release = await acquireClientLock(home);
  await assert.rejects(() => acquireClientLock(home), /already active/);
  await release(); const releaseAgain = await acquireClientLock(home); await releaseAgain();
});

test('cross-store file lock prevents lost updates from separate server instances', async () => {
  const ctx = await makeStore({ max: 1 }); const bobToken = 'meter-bob-token'; const state = JSON.parse(await readFile(ctx.file, 'utf8'));
  state.users.bob = { id: 'bob', tokenHash: hashToken(bobToken), enabled: true, used: zeroUsage() }; await atomicWriteJson(ctx.file, state);
  const first = new MeterStore(ctx.file); const second = new MeterStore(ctx.file);
  const [aliceLease, bobLease] = await Promise.all([first.start(ctx.token), second.start(bobToken)]);
  await Promise.all([first.update(ctx.token, aliceLease.body.leaseId, usage(10)), second.update(bobToken, bobLease.body.leaseId, usage(20))]);
  const final = JSON.parse(await readFile(ctx.file, 'utf8'));
  assert.equal(final.users.alice.used.total_tokens, 10); assert.equal(final.users.bob.used.total_tokens, 20);
});

test('finish deactivates atomically before a queued replacement start', async () => {
  const ctx = await makeStore(); const id = (await ctx.store.start(ctx.token)).body.leaseId;
  const [finished, replacement] = await Promise.all([ctx.store.finish(ctx.token, id, usage(2)), ctx.store.start(ctx.token)]);
  assert.equal(finished.status, 200); assert.equal(replacement.status, 201);
});

test('HTTP health, own usage, and admin endpoints enforce authentication', async (t) => {
  const { file, token } = await makeStore(); const server = createMeterServer({ stateFile: file });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (e) => e ? reject(e) : resolve()));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
  assert.equal((await fetch(`${base}/v1/usage`)).status, 401);
  assert.equal((await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(`${base}/admin.json`, { headers: { authorization: 'Bearer admin' } })).status, 200);
  const page = await fetch(`${base}/admin`, { headers: { authorization: 'Bearer admin' } }); assert.equal(page.status, 200); assert.match(await page.text(), /<table>/);
});

test('HTTP usage endpoint rejects content, unknown fields, missing counters, and bad numbers without mutation', async (t) => {
  const { file, token, store } = await makeStore(); const leaseId = (await store.start(token)).body.leaseId;
  const server = createMeterServer({ stateFile: file });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (e) => e ? reject(e) : resolve()));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/leases/${leaseId}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const invalid = [
    { usage: { ...usage(1), prompt: 'must-not-be-accepted' } },
    { usage: usage(1), source: 'must-not-be-accepted' },
    { usage: { total_tokens: 1 } },
    { usage: { ...usage(1), total_tokens: 1.5 } },
    { usage: { ...usage(1), total_tokens: -1 } }
  ];
  for (const value of invalid) assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(value) })).status, 400);
  assert.equal((await store.usage(token)).body.used.total_tokens, 0);
});

test('only HTTP 4xx meter errors are permanent', () => {
  assert.equal(isPermanentMeterError({ status: 400 }), true);
  assert.equal(isPermanentMeterError({ status: 401 }), true);
  assert.equal(isPermanentMeterError({ status: 500 }), false);
  assert.equal(isPermanentMeterError(new Error('offline')), false);
});

test('real wrapper-server path meters a fake Codex session and stops at quota', async (t) => {
  const ctx = await makeStore({ quota: 10, ttl: 10000 });
  const server = createMeterServer({ stateFile: ctx.file });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (e) => e ? reject(e) : resolve()));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const root = await temp();
  const meterHome = path.join(root, 'meter'); const codexHome = path.join(root, 'codex');
  await mkdir(meterHome, { recursive: true }); await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  await writeFile(path.join(meterHome, 'client.json'), `\uFEFF${JSON.stringify({
    serverUrl: `http://127.0.0.1:${server.address().port}/`, meterToken: ctx.token, pollIntervalMs: 1000
  })}`);
  const fake = path.join(root, 'fake-codex.mjs');
  await writeFile(fake, `#!/usr/bin/env node\nimport {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path';\nconst dir=path.join(process.env.CODEX_HOME,'sessions','live'); await mkdir(dir,{recursive:true});\nawait writeFile(path.join(dir,'run.jsonl'), JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:18,cached_input_tokens:2,output_tokens:2,reasoning_output_tokens:1,total_tokens:20}}}})+'\\n');\nawait new Promise(r=>setTimeout(r,5000));\n`);
  await chmod(fake, 0o700);

  const wrapper = path.join(import.meta.dirname, '..', 'bin', 'codex-meter.js');
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper, '--literal', 'x & y'], {
      env: { ...process.env, CODEX_METER_HOME: meterHome, CODEX_HOME: codexHome, CODEX_METER_CODEX: fake },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = ''; child.stderr.on('data', (x) => { stderr += x; });
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  assert.equal(result.code, 75, result.stderr); assert.match(result.stderr, /quota_exhausted/);
  const own = await ctx.store.usage(ctx.token); assert.equal(own.body.used.total_tokens, 20);
  assert.equal(Object.values((await readFile(ctx.file, 'utf8') && JSON.parse(await readFile(ctx.file, 'utf8'))).leases).some((x) => x.active), false);
});
