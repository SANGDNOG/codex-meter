import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openServerDatabase } from '../v2/server/database.js';
import { createV2Server } from '../v2/server/http.js';

const PASSWORD = 'correct horse battery staple';
async function fixture(callback, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-meter-m2-')); const filename = path.join(directory, 'meter.db');
  let database = openServerDatabase(filename); let now = Date.parse('2026-08-30T12:00:00.000Z');
  let server = createV2Server({ database, adminPassword: PASSWORD, serverUrl: 'https://meter.example', clock: () => now, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => { if (server.listening) await new Promise((resolve) => server.close(resolve)); if (database?.isOpen) database.close(); };
  const restart = async () => { await stop(); database = openServerDatabase(filename); server = createV2Server({ database, clock: () => now }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  const request = async (route, { method = 'GET', value, cookie, csrf, authorization, includeOrigin = true, forwardedProto = 'https' } = {}) => {
    const headers = {}; if (includeOrigin) headers.origin = forwardedProto === 'https' ? base.replace('http:', 'https:') : base; if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto; if (value !== undefined) headers['content-type'] = 'application/json'; if (cookie) headers.cookie = cookie; if (csrf) headers['x-csrf-token'] = csrf; if (authorization) headers.authorization = authorization;
    const response = await fetch(`${base}${route}`, { method, headers, body: value === undefined ? undefined : JSON.stringify(value) });
    let payload; try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, body: payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async () => { const result = await request('/api/v1/auth/login', { method: 'POST', value: { password: PASSWORD } }); assert.equal(result.status, 200); return { cookie: result.cookie, csrf: result.body.csrfToken }; };
  const admin = async (route, init = {}, auth) => request(route, { ...init, cookie: auth.cookie, csrf: auth.csrf });
  try { await callback({ get database(){return database;}, get server(){return server;}, get base(){return base;}, request, login, admin, restart, filename, advance(ms){now += ms;}, time(){return new Date(now).toISOString();} }); }
  finally { await stop(); await rm(directory, { recursive: true, force: true }); }
}
async function groupAndEnrollment(ctx, auth, name = 'Group A', device = 'Laptop') {
  const group = await ctx.admin('/api/v1/groups', { method: 'POST', value: { name } }, auth); assert.equal(group.status, 201);
  const pending = await ctx.admin('/api/v1/devices', { method: 'POST', value: { name: device, groupId: group.body.id } }, auth); assert.equal(pending.status, 201);
  return { group: group.body, pending: pending.body };
}
async function enroll(ctx, token) { const result = await ctx.request('/api/v1/agent/enroll', { method: 'POST', value: { token } }); assert.equal(result.status, 201); return result.body; }
function syncBody(events = []) { return { agentVersion: '2.0.0', codexVersion: '0.200.0', health: { status: 'healthy' }, events }; }
function event(eventId, occurredAt, total, extra = {}) { return { eventId, occurredAt, inputTokens: total, cachedInputTokens: '0', cacheWriteInputTokens: null, outputTokens: '0', reasoningOutputTokens: '0', totalTokens: total, model: 'gpt-5', reasoningEffort: 'high', ...extra }; }
function credential(device) { return `Bearer ${device.deviceId}.${device.deviceSecret}`; }

test('M2 admin sessions require password, same-origin and CSRF, store hashes, logout, and persist across restart', async () => fixture(async (ctx) => {
  assert.equal((await ctx.request('/api/v1/groups')).status, 401);
  assert.equal((await ctx.request('/api/v1/auth/login', { method: 'POST', value: { password: 'definitely wrong password' } })).status, 401);
  assert.equal((await ctx.request('/api/v1/auth/login', { method: 'POST', value: { password: PASSWORD }, includeOrigin: false })).status, 403);
  const auth = await ctx.login();
  assert.equal((await ctx.request('/api/v1/groups', { cookie: auth.cookie })).status, 200);
  assert.equal((await ctx.request('/api/v1/groups', { method: 'POST', value: { name: 'No CSRF' }, cookie: auth.cookie })).status, 403);
  const made = await ctx.admin('/api/v1/groups', { method: 'POST', value: { name: 'Persistent' } }, auth); assert.equal(made.status, 201);
  const rawCookie = decodeURIComponent(auth.cookie.split('=')[1]);
  const sessions = ctx.database.prepare('SELECT token_hash,csrf_token FROM admin_sessions').all();
  assert.equal(JSON.stringify(sessions).includes(rawCookie), false);
  const authRow = ctx.database.prepare('SELECT password_hash,password_salt FROM admin_auth').get(); assert.equal(JSON.stringify(authRow).includes(PASSWORD), false);
  await ctx.restart();
  const auth2 = await ctx.login(); const groups = await ctx.admin('/api/v1/groups', {}, auth2); assert.deepEqual(groups.body.groups.map((g) => g.name), ['Persistent']);
  assert.equal((await ctx.admin('/api/v1/auth/logout', { method: 'POST' }, auth2)).status, 200);
  assert.equal((await ctx.request('/api/v1/groups', { cookie: auth2.cookie })).status, 401);
}));

test('M2 enrollment rejects invalid, expired and reused tokens; concurrent consume has one winner; DB stores only salted hashes', async () => fixture(async (ctx) => {
  const auth = await ctx.login(); const { pending } = await groupAndEnrollment(ctx, auth);
  assert.equal((await ctx.request('/api/v1/agent/enroll', { method: 'POST', value: { token: 'not-a-real-token-value' } })).status, 401);
  const [left, right] = await Promise.all([
    ctx.request('/api/v1/agent/enroll', { method: 'POST', value: { token: pending.enrollmentToken } }),
    ctx.request('/api/v1/agent/enroll', { method: 'POST', value: { token: pending.enrollmentToken } })
  ]);
  assert.deepEqual([left.status, right.status].sort(), [201, 401]); const enrolled = left.status === 201 ? left.body : right.body;
  assert.equal((await ctx.request('/api/v1/agent/enroll', { method: 'POST', value: { token: pending.enrollmentToken } })).status, 401);
  const short = await ctx.admin('/api/v1/devices', { method: 'POST', value: { name: 'Expires', groupId: null, expiresInSeconds: 1 } }, auth); ctx.advance(1001);
  assert.equal((await ctx.request('/api/v1/agent/enroll', { method: 'POST', value: { token: short.body.enrollmentToken } })).status, 410);
  const enrollment = ctx.database.prepare('SELECT token_hash,token_salt FROM device_enrollments WHERE id=?').get(pending.enrollmentId);
  const device = ctx.database.prepare('SELECT credential_hash,credential_salt FROM devices WHERE id=?').get(enrolled.deviceId);
  assert.ok(enrollment.token_salt && device.credential_salt); assert.equal(JSON.stringify(enrollment).includes(pending.enrollmentToken), false); assert.equal(JSON.stringify(device).includes(enrolled.deviceSecret), false);
}));

test('M2 strict sync is idempotent, private, bounded, updates health, and rejects disabled/rotated/removed credentials', async () => fixture(async (ctx) => {
  const auth = await ctx.login(); const { pending } = await groupAndEnrollment(ctx, auth); const device = await enroll(ctx, pending.enrollmentToken); const authorization = credential(device);
  const first = await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization, value: syncBody([event('evt-1', ctx.time(), '9007199254740993')]) });
  assert.deepEqual(first.body.acceptedEventIds, ['evt-1']); assert.deepEqual(first.body.duplicateEventIds, []);
  const retry = await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization, value: syncBody([event('evt-1', ctx.time(), '9007199254740993')]) }); assert.deepEqual(retry.body.duplicateEventIds, ['evt-1']);
  assert.equal(ctx.database.prepare('SELECT COUNT(*) count FROM usage_events').get().count, 1);
  const detail = await ctx.admin(`/api/v1/devices/${device.deviceId}`, {}, auth); assert.equal(detail.body.health, 'healthy'); assert.equal(detail.body.agentVersion, '2.0.0');
  const leaked = event('bad', ctx.time(), '1', { groupId: pending.groupId }); assert.equal((await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization, value: syncBody([leaked]) })).status, 400);
  assert.equal((await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization, value: syncBody(Array.from({ length: 101 }, (_, i) => event(`x${i}`, ctx.time(), '1'))) })).status, 400);
  await ctx.admin(`/api/v1/devices/${device.deviceId}/disable`, { method: 'POST', value: { disabled: true } }, auth); assert.equal((await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization, value: syncBody() })).status, 401);
  await ctx.admin(`/api/v1/devices/${device.deviceId}/disable`, { method: 'POST', value: { disabled: false } }, auth); const rotated = await ctx.admin(`/api/v1/devices/${device.deviceId}/rotate`, { method: 'POST', value: {} }, auth);
  assert.equal((await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization, value: syncBody() })).status, 401); const rotatedAuth = `Bearer ${device.deviceId}.${rotated.body.deviceSecret}`; assert.equal((await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization: rotatedAuth, value: syncBody() })).status, 200);
  await ctx.admin(`/api/v1/devices/${device.deviceId}`, { method: 'DELETE' }, auth); assert.equal((await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization: rotatedAuth, value: syncBody() })).status, 401);
}));

test('M2 enrollment and Device bearer sync require TLS or an exact trusted HTTPS proxy', async () => fixture(async (ctx) => {
  const auth = await ctx.login(); const { pending } = await groupAndEnrollment(ctx, auth);
  const plaintextEnrollment = await ctx.request('/api/v1/agent/enroll', { method: 'POST', value: { token: pending.enrollmentToken }, forwardedProto: false });
  assert.deepEqual({ status: plaintextEnrollment.status, error: plaintextEnrollment.body.error }, { status: 426, error: 'https_required' });
  const spoofedEnrollment = await ctx.request('/api/v1/agent/enroll', { method: 'POST', value: { token: pending.enrollmentToken }, forwardedProto: 'https,http' });
  assert.equal(spoofedEnrollment.status, 426);
  const device = await enroll(ctx, pending.enrollmentToken); const authorization = credential(device);
  const plaintextSync = await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization, value: syncBody(), forwardedProto: false });
  assert.deepEqual({ status: plaintextSync.status, error: plaintextSync.body.error }, { status: 426, error: 'https_required' });
  assert.equal((await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization, value: syncBody() })).status, 200);
}));

test('M2 ignores forwarded HTTPS from an untrusted peer configuration', async () => fixture(async (ctx) => {
  const result = await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization: `Bearer device.${'x'.repeat(32)}`, value: syncBody(), forwardedProto: 'https' });
  assert.deepEqual({ status: result.status, error: result.body.error }, { status: 426, error: 'https_required' });
}, { trustedProxyAddresses: [] }));

test('M2 accounts two devices in same/different groups, historical moves, delayed events, and Unassigned', async () => fixture(async (ctx) => {
  const auth = await ctx.login(); const a = await groupAndEnrollment(ctx, auth, 'A', 'One'); const bGroup = await ctx.admin('/api/v1/groups', { method: 'POST', value: { name: 'B' } }, auth);
  const d1 = await enroll(ctx, a.pending.enrollmentToken);
  const p2 = await ctx.admin('/api/v1/devices', { method: 'POST', value: { name: 'Two', groupId: a.group.id } }, auth); const d2 = await enroll(ctx, p2.body.enrollmentToken);
  const p3 = await ctx.admin('/api/v1/devices', { method: 'POST', value: { name: 'None', groupId: null } }, auth); const d3 = await enroll(ctx, p3.body.enrollmentToken);
  const before = ctx.time();
  await Promise.all([
    ctx.request('/api/v1/agent/sync', { method: 'POST', authorization: credential(d1), value: syncBody([event('d1-a', before, '10')]) }),
    ctx.request('/api/v1/agent/sync', { method: 'POST', authorization: credential(d2), value: syncBody([event('d2-a', before, '20')]) })
  ]);
  ctx.advance(1000); await ctx.admin(`/api/v1/devices/${d2.deviceId}/move`, { method: 'POST', value: { groupId: bGroup.body.id } }, auth); ctx.advance(1000); const after = ctx.time();
  await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization: credential(d2), value: syncBody([event('delayed-before', before, '5'), event('after-move', after, '7')]) });
  await ctx.request('/api/v1/agent/sync', { method: 'POST', authorization: credential(d3), value: syncBody([event('unassigned', after, '8')]) });
  const summary = await ctx.admin('/api/v1/usage/summary?range=all', {}, auth); assert.equal(summary.body.measured.totalTokens, '50');
  const byName = Object.fromEntries(summary.body.groups.map((entry) => [entry.group?.name ?? 'Unassigned', entry.measured.totalTokens])); assert.deepEqual(byName, { A: '35', B: '7', Unassigned: '8' });
  assert.equal(summary.body.groups.find((entry) => entry.group?.name === 'A').share, 70); assert.equal(summary.body.groups.find((entry) => entry.group === null).share, 16);
  const rows = ctx.database.prepare('SELECT event_id,resolved_group_id FROM usage_events ORDER BY event_id').all(); assert.equal(rows.find((r)=>r.event_id==='delayed-before').resolved_group_id, a.group.id); assert.equal(rows.find((r)=>r.event_id==='after-move').resolved_group_id, bGroup.body.id); assert.equal(rows.find((r)=>r.event_id==='unassigned').resolved_group_id, null);
}));

test('M2 positive/negative adjustments are auditable and measured rows immutable; range/detail totals remain decimal strings', async () => fixture(async (ctx) => {
  const auth=await ctx.login();const {group,pending}=await groupAndEnrollment(ctx,auth);const device=await enroll(ctx,pending.enrollmentToken);
  await ctx.request('/api/v1/agent/sync',{method:'POST',authorization:credential(device),value:syncBody([event('m',ctx.time(),'100',{inputTokens:'90',outputTokens:'10'})])});
  const positive=await ctx.admin('/api/v1/usage/adjustments',{method:'POST',value:{groupId:group.id,deviceId:device.deviceId,amountTokens:'25',reason:'approved correction',occurredAt:ctx.time()}},auth);assert.equal(positive.status,201);
  const negative=await ctx.admin('/api/v1/usage/adjustments',{method:'POST',value:{groupId:group.id,amountTokens:'-5',reason:'remove duplicate external count',occurredAt:ctx.time()}},auth);assert.equal(negative.status,201);
  const detail=await ctx.admin(`/api/v1/usage/groups/${group.id}?range=all`,{},auth);assert.equal(detail.body.measured.totalTokens,'100');assert.equal(detail.body.measured.inputTokens,'90');assert.equal(detail.body.adjusted.totalTokens,'20');assert.equal(detail.body.combined.totalTokens,'120');
  assert.throws(()=>ctx.database.prepare("UPDATE usage_events SET total_tokens=0 WHERE event_id='m'").run(),/immutable/);assert.throws(()=>ctx.database.prepare("DELETE FROM usage_events WHERE event_id='m'").run(),/immutable/);
  assert.equal((await ctx.admin('/api/v1/usage/adjustments',{method:'POST',value:{amountTokens:'0',reason:'bad',occurredAt:ctx.time()}},auth)).status,400);
  const audit=ctx.database.prepare('SELECT amount_tokens,reason FROM usage_adjustments ORDER BY created_at,id').all();assert.equal(audit.length,2);assert.ok(audit.every((row)=>row.reason.length>0));
}));

test('M2 group/device CRUD, settings and health APIs validate and persist', async () => fixture(async (ctx) => {
  const auth=await ctx.login();assert.equal((await ctx.request('/api/v1/health',{includeOrigin:false})).status,200);const {group,pending}=await groupAndEnrollment(ctx,auth);const device=await enroll(ctx,pending.enrollmentToken);
  assert.equal((await ctx.admin(`/api/v1/groups/${group.id}`,{method:'PATCH',value:{name:'Renamed'}},auth)).body.name,'Renamed');assert.equal((await ctx.admin(`/api/v1/devices/${device.deviceId}`,{method:'PATCH',value:{name:'Desktop'}},auth)).body.name,'Desktop');
  const settings=await ctx.admin('/api/v1/settings',{method:'PATCH',value:{timezone:'America/New_York',quotaReporterDeviceId:device.deviceId}},auth);assert.equal(settings.body.timezone,'America/New_York');assert.equal(settings.body.quotaReporterDeviceId,device.deviceId);
  assert.equal((await ctx.admin(`/api/v1/groups/${group.id}`,{method:'DELETE'},auth)).body.archivedAt!==null,true);assert.equal((await ctx.admin('/api/v1/devices',{method:'POST',value:{name:'Bad',groupId:group.id}},auth)).status,400);
  await ctx.restart();const auth2=await ctx.login();assert.equal((await ctx.admin('/api/v1/settings',{},auth2)).body.timezone,'America/New_York');assert.equal((await ctx.admin(`/api/v1/devices/${device.deviceId}`,{},auth2)).body.name,'Desktop');
}));
