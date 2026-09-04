import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openServerDatabase } from '../v2/server/database.js';
import { MeterService } from '../v2/server/service.js';
import { createV2Server } from '../v2/server/http.js';

const START = Date.parse('2026-09-01T18:00:00.000Z');
const RESET_5H = '2026-09-01T22:00:00.000Z';
const PREVIOUS_RESET_5H = '2026-09-01T17:00:00.000Z';
const RESET_WEEKLY = '2026-09-07T00:00:00.000Z';
const NEXT_RESET_5H = '2026-09-02T03:00:00.000Z';
const FIVE_H = (usedPercent, resetsAt = RESET_5H) => ({ limitId: 'codex-primary', durationMinutes: 300, usedPercent, resetsAt, slot: 'primary' });
const WEEKLY = (usedPercent, resetsAt = RESET_WEEKLY) => ({ limitId: 'codex-secondary', durationMinutes: 10080, usedPercent, resetsAt, slot: 'secondary' });

async function fixture(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-meter-cycle-'));
  const dbPath = path.join(root, 'server.db');
  let database = openServerDatabase(dbPath);
  let now = options.now ?? START;
  let service = new MeterService(database, { adminPassword: 'quota cycle test password', clock: () => now, quotaStaleMs: 60_000 });
  let sequence = 0;
  const devices = new Map();
  const accounts = new Map();
  const groups = new Map();
  const ctx = {
    root,
    dbPath,
    get database() { return database; },
    get service() { return service; },
    now: () => now,
    setNow(value) { now = typeof value === 'string' ? Date.parse(value) : value; },
    advance(ms) { now += ms; },
    account(name = `Account ${accounts.size + 1}`) {
      const account = service.createAccount({ name });
      accounts.set(account.id, account);
      return account;
    },
    group(name = `Group ${groups.size + 1}`) {
      const group = service.createGroup({ name });
      groups.set(group.id, group);
      return group;
    },
    device(account, group = null, name = `device-${devices.size + 1}`) {
      database.prepare('INSERT INTO devices(id,name,credential_hash,current_group_id,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(name, name, 'hash', group?.id ?? null, new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
      if (group) database.prepare('INSERT INTO device_group_memberships(id,device_id,group_id,valid_from) VALUES(?,?,?,?)')
        .run(`membership-${name}`, name, group.id, '2020-01-01T00:00:00.000Z');
      service.bindAccount(name, { accountId: account.id, codexHomeKey: `home-${name}-${account.id}` });
      const row = database.prepare('SELECT * FROM devices WHERE id=?').get(name);
      devices.set(name, row);
      return row;
    },
    report(device, account, observedAt, windows, status = 'available', errorKind = null) {
      const report = { accountId: account.id, observedAt, status, planType: null, windows };
      if (errorKind !== null) report.errorKind = errorKind;
      return service.sync(device, { agentVersion: '2.1-test', codexVersion: '0.137.0', events: [], health: { status: 'healthy' }, quotaReports: [report] });
    },
    event(device, account, occurredAt, totalTokens, extra = {}) {
      sequence += 1;
      const eventId = extra.eventId ?? `cycle-event-${sequence}`;
      const event = { eventId, accountId: account?.id, occurredAt, inputTokens: String(totalTokens), cachedInputTokens: '0', cacheWriteInputTokens: null, outputTokens: '0', reasoningOutputTokens: '0', totalTokens: String(totalTokens), model: null, reasoningEffort: null };
      if (extra.legacy) delete event.accountId;
      return service.sync(device, { agentVersion: '2.1-test', codexVersion: '0.137.0', events: [event], health: { status: 'healthy' } });
    },
    full(device, account, usedPercent = 42, windows = null) {
      ctx.report(device, account, '2026-09-01T16:59:00.000Z', windows ?? [FIVE_H(80, PREVIOUS_RESET_5H)]);
      ctx.report(device, account, '2026-09-01T18:00:00.000Z', windows ? windows.map((window) => ({ ...window })) : [FIVE_H(usedPercent)]);
    },
    partial(device, account, usedPercent = 60, observedAt = '2026-09-01T17:30:00.000Z', windows = null) {
      ctx.report(device, account, observedAt, windows ?? [FIVE_H(usedPercent)]);
    },
    reopen() {
      database.close();
      database = openServerDatabase(dbPath);
      service = new MeterService(database, { adminPassword: 'quota cycle test password', clock: () => now, quotaStaleMs: 60_000 });
    }
  };
  try { await run(ctx); }
  finally { if (database.isOpen) database.close(); await rm(root, { recursive: true, force: true }); }
}

function windowFor(result, limitId = 'codex-primary', durationMinutes = 300) {
  return result.windows.find((window) => window.limitId === limitId && window.durationMinutes === durationMinutes);
}
function groupFor(window, groupId) { return window.groups.find((entry) => entry.group?.id === groupId); }
function unassignedFor(window) { return window.groups.find((entry) => entry.group === null); }

// Cycle detection (1-10)
test('QCA 01 same resetsAt remains the same partial cycle and baseline', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account);
  ctx.report(device, account, '2026-09-01T17:20:00.000Z', [FIVE_H(40)]);
  ctx.report(device, account, '2026-09-01T18:00:00.000Z', [FIVE_H(45)]);
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.equal(window.coverage.status, 'partial');
  assert.equal(window.coverage.from, '2026-09-01T17:20:00.000Z');
  assert.equal(window.estimate.basisPercentagePoints, 5);
}));

test('QCA 02 changed resetsAt creates a full cycle', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account);
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.equal(window.coverage.status, 'full'); assert.equal(window.coverage.from, '2026-09-01T17:00:00.000Z');
}));

test('QCA 03 a 5h reset does not reset weekly coverage or interval', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account);
  ctx.report(device, account, '2026-09-01T16:59:00.000Z', [FIVE_H(80, PREVIOUS_RESET_5H), WEEKLY(20)]);
  ctx.report(device, account, '2026-09-01T17:01:00.000Z', [FIVE_H(5), WEEKLY(21)]);
  const result = ctx.service.quotaAttribution(account.id);
  assert.equal(windowFor(result).coverage.status, 'full');
  const weekly = windowFor(result, 'codex-secondary', 10080);
  assert.equal(weekly.coverage.status, 'partial'); assert.equal(weekly.estimate.basisPercentagePoints, 1);
}));

test('QCA 04 a weekly reset does not reset 5h coverage or interval', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account);
  ctx.report(device, account, '2026-08-30T23:59:00.000Z', [WEEKLY(90, '2026-08-31T00:00:00.000Z')]);
  ctx.report(device, account, '2026-09-01T17:01:00.000Z', [FIVE_H(22), WEEKLY(3)]);
  const result = ctx.service.quotaAttribution(account.id);
  assert.equal(windowFor(result).coverage.status, 'partial');
  assert.equal(windowFor(result, 'codex-secondary', 10080).coverage.status, 'full');
}));

test('QCA 05 cycleStart equals resetsAt minus duration', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.partial(device, account);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).cycleStart, '2026-09-01T17:00:00.000Z');
}));

test('QCA 06 an event exactly before reset belongs to the old cycle', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account);
  ctx.setNow('2026-09-01T21:59:59.999Z');
  ctx.event(device, account, '2026-09-01T21:59:59.999Z', 7);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '7');
}));

test('QCA 07 an event exactly at reset is excluded from the old half-open interval', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account);
  ctx.event(device, account, RESET_5H, 7);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '0');
  ctx.setNow(RESET_5H); ctx.report(device, account, RESET_5H, [FIVE_H(1, NEXT_RESET_5H)]);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '7');
}));

test('QCA 08 delayed upload uses occurred_at rather than received_at', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account);
  ctx.setNow('2026-09-01T22:10:00.000Z');
  ctx.event(device, account, '2026-09-01T21:59:00.000Z', 9);
  ctx.report(device, account, '2026-09-01T22:10:00.000Z', [FIVE_H(1, NEXT_RESET_5H)]);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '0');
  assert.equal(ctx.service.usage('all', { accountId: account.id }).measured.totalTokens, '9');
}));

test('QCA 08a future usage is not attributed until occurredAt arrives', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account);
  ctx.event(device, account, '2026-09-01T19:00:00.000Z', 11);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '0');
  ctx.setNow('2026-09-01T19:00:00.000Z');
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '11');
}));

test('QCA 09 null resetsAt makes cycle attribution unavailable', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.partial(device, account, 50, '2026-09-01T17:30:00.000Z', [FIVE_H(50, null)]);
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.equal(window.coverage.status, 'unknown'); assert.equal(window.estimate.status, 'unavailable');
}));

test('QCA 10 invalid duration in persisted quota is attribution unavailable', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account);
  ctx.database.exec('PRAGMA ignore_check_constraints=ON');
  ctx.database.prepare(`INSERT INTO account_quota_current(account_id,identity_key,reporter_device_id,observed_at,plan_type,limit_id,duration_minutes,used_percent,resets_at,slot,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(account.id,'bad-duration',device.id,'2026-09-01T18:00:00.000Z',null,'codex-primary',0,50,RESET_5H,'primary','available');
  ctx.database.exec('PRAGMA ignore_check_constraints=OFF');
  const window = windowFor(ctx.service.quotaAttribution(account.id), 'codex-primary', 0);
  assert.equal(window.coverage.status, 'unknown'); assert.equal(window.estimate.reason, 'cycle_boundary_unknown');
}));

test('QCA 10a null reset history cannot prove full-cycle coverage', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account);
  ctx.report(device, account, '2026-09-01T16:59:00.000Z', [FIVE_H(80, null)]);
  ctx.report(device, account, '2026-09-01T18:00:00.000Z', [FIVE_H(42)]);
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.equal(window.coverage.status, 'partial');
  assert.equal(window.coverage.from, '2026-09-01T18:00:00.000Z');
}));

test('QCA 10b non-adjacent reset history cannot prove full-cycle coverage', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account);
  ctx.report(device, account, '2026-09-01T11:59:00.000Z', [FIVE_H(80, '2026-09-01T12:00:00.000Z')]);
  ctx.report(device, account, '2026-09-01T18:00:00.000Z', [FIVE_H(42)]);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).coverage.status, 'partial');
}));

test('QCA 10c stale previous-cycle report after the boundary cannot prove full coverage', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account);
  ctx.report(device, account, '2026-09-01T17:10:00.000Z', [FIVE_H(80, PREVIOUS_RESET_5H)]);
  ctx.report(device, account, '2026-09-01T18:00:00.000Z', [FIVE_H(42)]);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).coverage.status, 'partial');
}));

// Contribution (11-18)
test('QCA 11 one Group receives 100 percent tracked share', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 10);
  assert.equal(groupFor(windowFor(ctx.service.quotaAttribution(account.id)), group.id).trackedSharePercent, 100);
}));

test('QCA 12 one Group full-cycle estimate equals provider usedPercent', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account, 42); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 10);
  assert.equal(groupFor(windowFor(ctx.service.quotaAttribution(account.id)), group.id).estimatedQuotaContributionPercentagePoints, 42);
}));

test('QCA 13 tracked token split is 20/30/50', () => fixture(async (ctx) => {
  const account = ctx.account(), groups = [ctx.group('A'), ctx.group('B'), ctx.group('C')], devices = groups.map((group, index) => ctx.device(account, group, `d${index}`)); ctx.full(devices[0], account);
  [20, 30, 50].forEach((tokens, index) => ctx.event(devices[index], account, '2026-09-01T18:00:00.000Z', tokens));
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.deepEqual(groups.map((group) => groupFor(window, group.id).trackedSharePercent), [20, 30, 50]);
}));

test('QCA 14 estimated percentage points equal usedPercent times exact share', () => fixture(async (ctx) => {
  const account = ctx.account(), a = ctx.group('A'), b = ctx.group('B'), da = ctx.device(account, a, 'da'), db = ctx.device(account, b, 'db'); ctx.full(da, account, 42);
  ctx.event(da, account, '2026-09-01T18:00:00.000Z', 1); ctx.event(db, account, '2026-09-01T18:00:00.000Z', 2);
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.equal(groupFor(window, a.id).estimatedQuotaContributionPercentagePoints, 14);
  assert.equal(groupFor(window, b.id).estimatedQuotaContributionPercentagePoints, 28);
}));

test('QCA 15 Unassigned is included in the denominator', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), assigned = ctx.device(account, group, 'assigned'), unassigned = ctx.device(account, null, 'unassigned'); ctx.full(assigned, account, 50);
  ctx.event(assigned, account, '2026-09-01T18:00:00.000Z', 9); ctx.event(unassigned, account, '2026-09-01T18:00:00.000Z', 1);
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.equal(groupFor(window, group.id).trackedSharePercent, 90); assert.equal(unassignedFor(window).trackedSharePercent, 10);
}));

test('QCA 16 zero tracked total does not divide by zero', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account);
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.equal(window.tracked.totalTokens, '0'); assert.equal(window.estimate.status, 'no_tracked_usage');
  assert.equal(unassignedFor(window).trackedSharePercent, null);
}));

test('QCA 17 int64 token totals remain exact above Number safe range', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account);
  ctx.event(device, account, '2026-09-01T18:00:00.000Z', '9223372036854775807');
  ctx.setNow('2026-09-01T18:01:00.000Z');
  ctx.event(device, account, '2026-09-01T18:01:00.000Z', '9223372036854775807');
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '18446744073709551614');
}));

test('QCA 18 display rounding does not mutate raw measured accounting', () => fixture(async (ctx) => {
  const account = ctx.account(), a = ctx.group('A'), b = ctx.group('B'), da = ctx.device(account, a, 'da'), db = ctx.device(account, b, 'db'); ctx.full(da, account, 33.333333);
  ctx.event(da, account, '2026-09-01T18:00:00.000Z', 1); ctx.event(db, account, '2026-09-01T18:00:00.000Z', 2);
  const window = windowFor(ctx.service.quotaAttribution(account.id));
  assert.equal(groupFor(window, a.id).trackedSharePercent, 33.333333); assert.equal(groupFor(window, b.id).trackedSharePercent, 66.666667);
  assert.equal(groupFor(window, a.id).estimatedQuotaContributionPercentagePoints, 11.111111); assert.equal(groupFor(window, b.id).estimatedQuotaContributionPercentagePoints, 22.222222);
  assert.equal(ctx.service.usage('all', { accountId: account.id }).measured.totalTokens, '3');
}));

// Reset and preservation (19-24)
test('QCA 19 old cycle usage is visible before reset', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account); ctx.event(device, account, '2026-09-01T21:00:00.000Z', 51);
  ctx.setNow('2026-09-01T21:30:00.000Z'); assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '51');
}));

test('QCA 20 new current cycle starts at zero after reset observation', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account); ctx.event(device, account, '2026-09-01T21:00:00.000Z', 51);
  ctx.setNow('2026-09-01T22:01:00.000Z'); ctx.report(device, account, '2026-09-01T22:01:00.000Z', [FIVE_H(0, NEXT_RESET_5H)]);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '0');
}));

test('QCA 20a expired snapshot is unavailable before the next cycle observation', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account); ctx.setNow(RESET_5H);
  const result = ctx.service.quotaAttribution(account.id), window = windowFor(result);
  assert.equal(result.quota.status, 'unavailable'); assert.equal(window.usedPercent, null); assert.equal(window.resetsAt, null);
  assert.equal(window.estimate.status, 'unavailable'); assert.equal(window.estimate.reason, 'quota_snapshot_expired');
}));

test('QCA 21 raw old events remain in the database after reset', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account); ctx.event(device, account, '2026-09-01T21:00:00.000Z', 51);
  ctx.setNow('2026-09-01T22:01:00.000Z'); ctx.report(device, account, '2026-09-01T22:01:00.000Z', [FIVE_H(0, NEXT_RESET_5H)]); ctx.service.quotaAttribution(account.id);
  assert.equal(ctx.database.prepare('SELECT COUNT(*) count FROM usage_events').get().count, 1);
}));

test('QCA 22 old usage remains visible in 7D 30D and All', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account); ctx.event(device, account, '2026-09-01T21:00:00.000Z', 51);
  ctx.setNow('2026-09-01T22:01:00.000Z'); ctx.report(device, account, '2026-09-01T22:01:00.000Z', [FIVE_H(0, NEXT_RESET_5H)]);
  for (const range of ['7d', '30d', 'all']) assert.equal(ctx.service.usage(range, { accountId: account.id }).measured.totalTokens, '51');
}));

test('QCA 23 new events only affect the new current cycle', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account); ctx.event(device, account, '2026-09-01T21:00:00.000Z', 51);
  ctx.setNow('2026-09-01T22:01:00.000Z'); ctx.report(device, account, '2026-09-01T22:01:00.000Z', [FIVE_H(1, NEXT_RESET_5H)]); ctx.event(device, account, '2026-09-01T22:01:00.000Z', 3);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '3'); assert.equal(ctx.service.usage('all', { accountId: account.id }).measured.totalTokens, '54');
}));

test('QCA 24 restart preserves snapshot-derived cycle history', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 8); ctx.reopen();
  const window = windowFor(ctx.service.quotaAttribution(account.id)); assert.equal(window.coverage.status, 'full'); assert.equal(window.tracked.totalTokens, '8');
}));

// Partial cycle (25-30)
test('QCA 25 first ever observed cycle is partial', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.partial(device, account);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).coverage.status, 'partial');
}));

test('QCA 26 first fresh observation becomes partial baseline', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.partial(device, account, 60, '2026-09-01T17:00:30.000Z');
  ctx.report(device, account, '2026-09-01T18:00:00.000Z', [FIVE_H(72)]);
  const window = windowFor(ctx.service.quotaAttribution(account.id)); assert.equal(window.coverage.from, '2026-09-01T17:00:30.000Z'); assert.equal(window.coverage.baselineUsedPercent, 60);
}));

test('QCA 27 partial contribution uses quota delta not full usedPercent', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.partial(device, account, 60); ctx.report(device, account, '2026-09-01T18:00:00.000Z', [FIVE_H(72)]); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 10);
  const entry = groupFor(windowFor(ctx.service.quotaAttribution(account.id)), group.id); assert.equal(entry.estimatedQuotaContributionPercentagePoints, 12);
}));

test('QCA 28 partial denominator starts at coverage baseline', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.event(device, account, '2026-09-01T17:00:00.000Z', 100); ctx.partial(device, account, 60, '2026-09-01T17:30:00.000Z'); ctx.event(device, account, '2026-09-01T17:30:00.000Z', 5);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '5');
}));

test('QCA 28a partial boundaries, account isolation, future filtering, disabled history, and revisions preserve the denominator', () => fixture(async (ctx) => {
  const account = ctx.account('Target'), other = ctx.account('Other'), device = ctx.device(account), otherDevice = ctx.device(other);
  ctx.partial(device, account, 60, '2026-09-01T17:30:00.000Z');
  ctx.event(device, account, '2026-09-01T17:29:59.999Z', 100);
  ctx.event(device, account, '2026-09-01T17:30:00.000Z', 2);
  ctx.event(device, account, '2026-09-01T17:30:00.001Z', 3);
  ctx.event(otherDevice, other, '2026-09-01T17:45:00.000Z', 200);
  ctx.event(device, account, '2026-09-01T18:00:00.001Z', 400);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '5');
  ctx.service.updateAccount(account.id, { name: 'Target renamed' });
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '5');
  const binding = ctx.database.prepare('SELECT id FROM device_account_bindings WHERE device_id=? AND account_id=?').get(device.id, account.id);
  ctx.database.prepare('UPDATE device_account_bindings SET disabled_at=? WHERE id=?').run('2026-09-01T17:50:00.000Z', binding.id);
  assert.equal(ctx.event(device, account, '2026-09-01T17:49:59.999Z', 7).acceptedEventIds.length, 1);
  assert.deepEqual(ctx.event(device, account, '2026-09-01T17:50:00.000Z', 11).rejectedEvents.map(item=>item.reason), ['account_not_bound']);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).tracked.totalTokens, '12');
}));

test('QCA 29 negative same-cycle quota delta is ambiguous and unavailable', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.partial(device, account, 60); ctx.report(device, account, '2026-09-01T18:00:00.000Z', [FIVE_H(58)]);
  const estimate = windowFor(ctx.service.quotaAttribution(account.id)).estimate; assert.equal(estimate.status, 'ambiguous'); assert.equal(estimate.reason, 'provider_used_percent_regressed');
}));

test('QCA 30 next observed reset transitions partial tracking to full', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.partial(device, account, 60); ctx.setNow('2026-09-01T22:01:00.000Z'); ctx.report(device, account, '2026-09-01T22:01:00.000Z', [FIVE_H(1, NEXT_RESET_5H)]);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).coverage.status, 'full');
}));

// Account isolation (31-34)
test('QCA 31 Personal usage does not enter Research denominator', () => fixture(async (ctx) => {
  const personal = ctx.account('Personal'), research = ctx.account('Research'), group = ctx.group(), dp = ctx.device(personal, group, 'personal'), dr = ctx.device(research, group, 'research'); ctx.full(dp, personal); ctx.full(dr, research);
  ctx.event(dp, personal, '2026-09-01T18:00:00.000Z', 10); ctx.event(dr, research, '2026-09-01T18:00:00.000Z', 90);
  assert.equal(windowFor(ctx.service.quotaAttribution(personal.id)).tracked.totalTokens, '10');
}));

test('QCA 32 Personal quota does not affect Research estimate', () => fixture(async (ctx) => {
  const personal = ctx.account('Personal'), research = ctx.account('Research'), group = ctx.group(), dp = ctx.device(personal, group, 'personal'), dr = ctx.device(research, group, 'research'); ctx.full(dp, personal, 90); ctx.full(dr, research, 10);
  ctx.event(dp, personal, '2026-09-01T18:00:00.000Z', 1); ctx.event(dr, research, '2026-09-01T18:00:00.000Z', 1);
  assert.equal(groupFor(windowFor(ctx.service.quotaAttribution(research.id)), group.id).estimatedQuotaContributionPercentagePoints, 10);
}));

test('QCA 33 same Group on two Accounts is calculated independently', () => fixture(async (ctx) => {
  const a = ctx.account('A'), b = ctx.account('B'), group = ctx.group(), da = ctx.device(a, group, 'a'), db = ctx.device(b, group, 'b'); ctx.full(da, a, 20); ctx.full(db, b, 70); ctx.event(da, a, '2026-09-01T18:00:00.000Z', 2); ctx.event(db, b, '2026-09-01T18:00:00.000Z', 7);
  assert.equal(groupFor(windowFor(ctx.service.quotaAttribution(a.id)), group.id).estimatedQuotaContributionPercentagePoints, 20);
  assert.equal(groupFor(windowFor(ctx.service.quotaAttribution(b.id)), group.id).estimatedQuotaContributionPercentagePoints, 70);
}));

test('QCA 34 account-null legacy events are excluded and warned', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 99, { legacy: true });
  const result = ctx.service.quotaAttribution(account.id); assert.equal(windowFor(result).tracked.totalTokens, '0'); assert.ok(result.warnings.includes('legacy_unattributed_events_exist'));
}));

// Status (35-40)
test('QCA 35 fresh quota produces an available estimate', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 1);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).estimate.status, 'available');
}));

test('QCA 36 stale quota estimate is explicitly stale', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 1); ctx.advance(60_001);
  assert.equal(windowFor(ctx.service.quotaAttribution(account.id)).estimate.status, 'stale');
}));

test('QCA 36a reporter offline is distinct from snapshot staleness', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 1);
  ctx.database.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run('2026-09-01T00:00:00.000Z', device.id);
  const result = ctx.service.quotaAttribution(account.id), window = windowFor(result);
  assert.equal(result.quota.reporterState, 'reporter_offline'); assert.equal(result.quota.status, 'available');
  assert.equal(window.estimate.status, 'available'); assert.equal(window.estimate.reason, null);
}));

test('QCA 37 unavailable quota keeps known-cycle tracked tokens but no estimate', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 5);
  ctx.report(device, account, '2026-09-01T18:00:30.000Z', [], 'unavailable', 'app_server_unavailable');
  const window = windowFor(ctx.service.quotaAttribution(account.id)); assert.equal(window.tracked.totalTokens, '5'); assert.equal(window.estimate.status, 'unavailable');
}));

test('QCA 38 partial coverage reports since-tracking semantics', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.partial(device, account);
  const window = windowFor(ctx.service.quotaAttribution(account.id)); assert.equal(window.coverage.status, 'partial'); assert.equal(window.estimate.semantics, 'since_tracking_began');
}));

test('QCA 39 full coverage reports full-cycle semantics', () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.full(device, account);
  const window = windowFor(ctx.service.quotaAttribution(account.id)); assert.equal(window.coverage.status, 'full'); assert.equal(window.estimate.semantics, 'full_cycle');
}));

test('QCA 40 no quota reporter is explicit and does not invent a window', () => fixture(async (ctx) => {
  const account = ctx.account(); const result = ctx.service.quotaAttribution(account.id);
  assert.equal(result.quota.reporterState, 'no_reporter'); assert.deepEqual(result.windows, []);
}));

test('QCA 40a disabling the reporting binding suppresses the old provider estimate', () => fixture(async (ctx) => {
  const account = ctx.account(), group = ctx.group(), device = ctx.device(account, group); ctx.full(device, account); ctx.event(device, account, '2026-09-01T18:00:00.000Z', 5);
  ctx.database.prepare('UPDATE device_account_bindings SET disabled_at=? WHERE device_id=? AND account_id=?').run('2026-09-01T18:00:01.000Z', device.id, account.id);
  const result = ctx.service.quotaAttribution(account.id), window = windowFor(result);
  assert.equal(result.quota.status, 'unavailable'); assert.equal(result.quota.reporterState, 'no_reporter'); assert.equal(result.quota.reporterDeviceId, null);
  assert.equal(window.tracked.totalTokens, '5'); assert.equal(window.usedPercent, null); assert.equal(window.estimate.status, 'unavailable'); assert.equal(window.estimate.reason, 'provider_quota_unavailable');
}));

test('QCA authenticated endpoint returns account-scoped quota attribution', async () => fixture(async (ctx) => {
  const account = ctx.account(), device = ctx.device(account); ctx.partial(device, account);
  const server = createV2Server({ database: ctx.database, adminPassword: 'quota cycle test password', clock: ctx.now, quotaStaleMs: 60_000 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'quota cycle test password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/api/v1/accounts/${account.id}/quota-attribution`, { headers: { cookie } });
    assert.equal(response.status, 200); assert.equal((await response.json()).accountId, account.id);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));
