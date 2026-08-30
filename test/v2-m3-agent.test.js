import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAgentDatabase } from '../v2/agent/database.js';
import { AgentCollector, classifyRollout } from '../v2/agent/collector.js';
import { discoverRollouts } from '../v2/agent/discovery.js';
import { readCompleteLines } from '../v2/agent/reader.js';
import { AgentSyncClient } from '../v2/agent/sync.js';
import { enroll, loadConfig, saveConfig } from '../v2/agent/config.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
function line(value) { return `${JSON.stringify(value)}\n`; }
function meta(extra = {}) { return { type: 'session_meta', payload: { id: UUID, model: 'gpt-5', reasoning_effort: 'high', ...extra } }; }
function usage(total, timestamp = '2026-08-30T12:00:00Z', extra = {}) {
  return { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: {
    input_tokens: total, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: total, ...extra
  } } } };
}
async function fixture(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-meter-m3-'));
  const home = path.join(directory, '.codex'); const sessions = path.join(home, 'sessions', '2026', '08', '30');
  await mkdir(sessions, { recursive: true }); const dbPath = path.join(directory, 'agent.db'); let database = openAgentDatabase(dbPath);
  try { await callback({ directory, home, sessions, dbPath, get database() { return database; }, reopen() { database.close(); database = openAgentDatabase(dbPath); return database; } }); }
  finally { if (database.isOpen) database.close(); await rm(directory, { recursive: true, force: true }); }
}
function filename(root, uuid = UUID) { return path.join(root, `rollout-2026-08-30T12-00-00-${uuid}.jsonl`); }
function rows(database) { const statement = database.prepare('SELECT * FROM usage_outbox ORDER BY sequence'); statement.setReadBigInts(true); return statement.all(); }

// Installation is a transaction-wide EOF baseline. Subsequent append is counted using lastUsage only.
test('M3 installation baseline excludes history, then root append persists a stable allowlisted event across restart', async () => fixture(async (f) => {
  const file = filename(f.sessions); await writeFile(file, line(meta()) + line(usage(999)));
  let collector = new AgentCollector(f.database, { home: f.home });
  assert.deepEqual(await collector.reconcile(), { baseline: 1, events: 0, files: 1, compressedOnly: 0 });
  await appendFile(file, line(usage(7, '2026-08-30T12:01:00Z', { cache_write_input_tokens: 4 })));
  assert.equal((await collector.reconcile()).events, 1);
  const first = rows(f.database)[0];
  assert.equal(first.total_tokens, 7n); assert.equal(first.cached_input_tokens, 2n); assert.equal(first.reasoning_output_tokens, 1n);
  assert.equal(JSON.stringify({ ...first }, (_, value) => typeof value === 'bigint' ? value.toString() : value).includes(file), false);
  const eventId = first.event_id;
  f.reopen(); collector = new AgentCollector(f.database, { home: f.home }); await collector.reconcile();
  assert.equal(rows(f.database).length, 1); assert.equal(rows(f.database)[0].event_id, eventId);
}));

test('M3 new root is counted, partial final JSONL is retried byte-completely, and bounds stop on line boundaries', async () => fixture(async (f) => {
  await new AgentCollector(f.database, { home: f.home }).reconcile();
  const file = filename(f.sessions); const complete = line(meta()); const event = line(usage(13));
  await writeFile(file, complete + event.slice(0, 20));
  let collector = new AgentCollector(f.database, { home: f.home });
  await collector.reconcile(); // ambiguous until SessionMeta is visible, so this file is safely baselined at its partial EOF
  assert.equal(rows(f.database).length, 0);
  // A separate root demonstrates partial handling after classification/cursor creation.
  const file2 = filename(f.sessions, UUID2); await writeFile(file2, line(meta({ id: UUID2 })) + event);
  await collector.reconcile(); assert.equal(rows(f.database).length, 1);
  const next = line(usage(17, '2026-08-30T12:02:00Z')); await appendFile(file2, next.slice(0, -3));
  await collector.reconcile(); assert.equal(rows(f.database).length, 1);
  await appendFile(file2, next.slice(-3)); await collector.reconcile(); assert.equal(rows(f.database).length, 2);
  const bounded = await readCompleteLines(file2, 0, { maxLineBytes: 1024, maxReadBytes: 1024, maxLines: 1 });
  assert.equal(bounded.lines.length, 1); assert.equal(bounded.nextOffset, Buffer.byteLength(line(meta({ id: UUID2 }))));
}));

test('M3 cursor and outbox insertion roll back together on failure and recover on retry', async () => fixture(async (f) => {
  await new AgentCollector(f.database, { home: f.home }).reconcile();
  const file = filename(f.sessions); await writeFile(file, line(meta()) + line(usage(21)));
  f.database.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON usage_outbox BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  const collector = new AgentCollector(f.database, { home: f.home }); await assert.rejects(collector.reconcile(), /simulated crash/);
  assert.equal(f.database.prepare('SELECT COUNT(*) count FROM rollout_cursors').get().count, 0);
  assert.equal(rows(f.database).length, 0);
  f.database.exec('DROP TRIGGER fail_outbox'); await collector.reconcile(); assert.equal(rows(f.database).length, 1);
}));

test('M3 archive move and plain-over-zst discovery retain one physical cursor/event', async () => fixture(async (f) => {
  await new AgentCollector(f.database, { home: f.home }).reconcile(); const active = filename(f.sessions);
  await writeFile(active, line(meta()) + line(usage(31))); const collector = new AgentCollector(f.database, { home: f.home }); await collector.reconcile();
  const archive = path.join(f.home, 'archived_sessions'); await mkdir(archive, { recursive: true }); const archived = filename(archive);
  await rename(active, archived); await writeFile(`${archived}.zst`, 'not-read');
  const found = await discoverRollouts({ home: f.home }); assert.equal(found.files.length, 1); assert.equal(found.files[0].path, archived);
  assert.equal(found.compressedDetected, true); assert.equal(found.compressedOnly, 0);
  await collector.reconcile(); assert.equal(rows(f.database).length, 1); assert.equal(f.database.prepare('SELECT COUNT(*) count FROM rollout_cursors').get().count, 1);
}));

test('M3 compressed-only history is remembered and safely baselined if a plain representation later appears', async () => fixture(async (f) => {
  const compressed = `${filename(f.sessions)}.zst`; await writeFile(compressed, 'compressed-history');
  const collector = new AgentCollector(f.database, { home: f.home });
  assert.equal((await collector.reconcile()).compressedOnly, 1);
  await rm(compressed); const plain = filename(f.sessions); await writeFile(plain, line(meta()) + line(usage(400)));
  await collector.reconcile(); assert.equal(rows(f.database).length, 0);
  await appendFile(plain, line(usage(8, '2026-08-30T12:08:00Z'))); await collector.reconcile();
  assert.deepEqual(rows(f.database).map((row) => row.total_tokens), [8n]);
}));

test('M3 oversized unterminated records advance in bounded discard mode without storing raw content', async () => fixture(async (f) => {
  const file = filename(f.sessions); await writeFile(file, 'SENSITIVE'.repeat(100));
  const first = await readCompleteLines(file, 0, { maxLineBytes: 32, maxReadBytes: 64, maxLines: 10 });
  assert.equal(first.lines.length, 0); assert.equal(first.discardUntilNewline, true); assert.ok(first.nextOffset <= 65);
  await appendFile(file, `\n${line(meta())}`);
  const second = await readCompleteLines(file, first.nextOffset, { maxLineBytes: 1024, maxReadBytes: 1024, maxLines: 10, discardUntilNewline: true });
  assert.deepEqual(second.lines.map(({ record }) => record.type), ['session_meta']);
}));

test('M3 inherited and structurally ambiguous new rollouts baseline safely while later appends are collectable', async () => fixture(async (f) => {
  assert.equal(classifyRollout([meta({ source: { subagent: { thread_spawn: { parent_thread_id: UUID } } } })]), 'inherited');
  assert.equal(classifyRollout([meta({ parent_thread_id: UUID })]), 'ambiguous'); assert.equal(classifyRollout([meta()]), 'root');
  await new AgentCollector(f.database, { home: f.home }).reconcile();
  const inherited = filename(f.sessions); await writeFile(inherited, line(meta({ source: { subagent: { thread_spawn: { parent_thread_id: UUID } } } })) + line(usage(100)));
  const ambiguous = filename(f.sessions, UUID2); await writeFile(ambiguous, line(meta({ id: UUID2, parent_thread_id: UUID })) + line(usage(200)));
  const collector = new AgentCollector(f.database, { home: f.home }); await collector.reconcile(); assert.equal(rows(f.database).length, 0);
  await appendFile(inherited, line(usage(5, '2026-08-30T12:03:00Z'))); await appendFile(ambiguous, line(usage(6, '2026-08-30T12:04:00Z')));
  await collector.reconcile(); assert.deepEqual(rows(f.database).map((row) => row.total_tokens).sort(), [5n, 6n]);
  assert.deepEqual(f.database.prepare('SELECT classification FROM rollout_cursors ORDER BY classification').all().map((r) => r.classification), ['ambiguous', 'inherited']);
}));

function config(deviceId = 'device-a') { return { serverUrl: 'http://127.0.0.1:1', deviceId, deviceSecret: 'x'.repeat(32), maxBatchSize: 100 }; }
function insertEvents(database, count, prefix = 'e') {
  const statement = database.prepare(`INSERT INTO usage_outbox(event_id,occurred_at,total_tokens,created_at) VALUES(?,?,?,?)`);
  for (let i = 0; i < count; i++) statement.run(`${prefix}${i}`, '2026-08-30T12:00:00.000Z', BigInt(i + 1), '2026-08-30T12:00:00.000Z');
}
test('M3 sync is <=100 at-least-once, retains outages/unknown acks, and deletes accepted or duplicate only', async () => fixture(async (f) => {
  insertEvents(f.database, 101); let requests = 0; let captured;
  const unavailable = new AgentSyncClient(f.database, config(), { fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(unavailable.sync(), /unavailable/); assert.equal(rows(f.database).length, 101);
  const sync = new AgentSyncClient(f.database, config(), { fetchImpl: async (_url, request) => {
    requests++; captured = JSON.parse(request.body); return { ok: true, json: async () => captured.events.length === 100 ? ({
      acceptedEventIds: captured.events.slice(0, 98).map((e) => e.eventId), duplicateEventIds: [captured.events[98].eventId],
      ignored: [captured.events[99].eventId], serverTime: '2026-08-30T12:05:00Z', agentConfiguration: { maxBatchSize: 100 }
    }) : ({ acceptedEventIds: captured.events.map((event) => event.eventId), duplicateEventIds: [] }) };
  } });
  const result = await sync.sync(); assert.equal(captured.events.length, 100); assert.equal(result.acknowledged, 99); assert.equal(rows(f.database).length, 2);
  assert.equal(requests, 1); assert.equal(JSON.stringify(captured).includes('deviceSecret'), false);
  const heartbeat = await sync.sync({ heartbeat: true }); assert.equal(heartbeat.sent, 2);
}));

test('M3 duplicate acknowledgement after lost response and independent agent DBs preserve delivery identity', async () => {
  const directories = await Promise.all([0, 1].map(() => mkdtemp(path.join(os.tmpdir(), 'codex-meter-independent-'))));
  const databases = directories.map((dir) => openAgentDatabase(path.join(dir, 'agent.db')));
  try {
    insertEvents(databases[0], 1, 'stable-'); insertEvents(databases[1], 1, 'stable-');
    for (let index = 0; index < 2; index++) {
      let attempt = 0;
      const client = new AgentSyncClient(databases[index], config(`device-${index}`), { fetchImpl: async (_url, request) => {
        attempt++; const id = JSON.parse(request.body).events[0].eventId;
        if (attempt === 1) throw new Error('response lost after acceptance');
        return { ok: true, json: async () => ({ acceptedEventIds: [], duplicateEventIds: [id] }) };
      } });
      await assert.rejects(client.sync()); assert.equal(rows(databases[index])[0].event_id, 'stable-0');
      await client.sync(); assert.equal(rows(databases[index]).length, 0);
    }
  } finally { databases.forEach((db) => db.close()); await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true }))); }
});

test('M3 enrollment writes protected config atomically and load rejects broad permissions', async () => fixture(async (f) => {
  let requestBody; const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); requestBody = JSON.parse(Buffer.concat(chunks));
    response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({
      deviceId: 'device-enrolled', deviceSecret: 's'.repeat(32), serverUrl: `http://127.0.0.1:${server.address().port}`,
      agentConfiguration: { syncIntervalSeconds: 15, heartbeatIntervalSeconds: 60, maxBatchSize: 100 }
    }));
  }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const configPath = path.join(f.directory, 'private', 'agent.json');
  try {
    await enroll({ serverUrl: `http://127.0.0.1:${server.address().port}`, token: 'one-time-token', configPath, allowHttpForTests: true, codexHome: f.home, databasePath: f.dbPath });
    assert.deepEqual(requestBody, { token: 'one-time-token' }); assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await loadConfig(configPath)).deviceId, 'device-enrolled'); assert.equal((await readFile(configPath, 'utf8')).includes('one-time-token'), false);
    if (process.platform !== 'win32') { await chmod(configPath, 0o644); await assert.rejects(loadConfig(configPath), /permissions/); }
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

test('M3 saveConfig rejects insecure remote HTTP and unknown fields', async () => fixture(async (f) => {
  const target = path.join(f.directory, 'agent.json');
  await assert.rejects(saveConfig(target, { ...config(), serverUrl: 'http://example.com' }), /HTTPS/);
  await assert.rejects(saveConfig(target, { ...config(), surprise: 'secret' }), /unknown/);
}));
