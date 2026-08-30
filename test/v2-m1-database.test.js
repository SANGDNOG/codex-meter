import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAgentDatabase } from '../v2/agent/database.js';
import { openServerDatabase } from '../v2/server/database.js';

async function withDatabase(kind, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `codex-meter-v2-${kind}-`));
  const filename = path.join(directory, `${kind}.db`);
  let database;
  try {
    database = kind === 'agent' ? openAgentDatabase(filename) : openServerDatabase(filename);
    await callback(database, filename);
  } finally {
    if (database?.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function scalar(database, sql) {
  return database.prepare(sql).get();
}

test('agent migrations are versioned, idempotent, WAL-enabled, and 64-bit-safe', async () => {
  await withDatabase('agent', async (database, filename) => {
    if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.equal(scalar(database, 'PRAGMA journal_mode').journal_mode, 'wal');
    assert.equal(scalar(database, 'PRAGMA foreign_keys').foreign_keys, 1);
    const migrations = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row }));
    assert.deepEqual(migrations[0], { version: 1, name: 'initial' });
    assert.equal(migrations.some(({ version, name }) => version === 1 && name === 'initial'), true);
    database.prepare(`INSERT INTO rollout_cursors
      (rollout_key, byte_offset, updated_at) VALUES (?, ?, ?)`).run('hash:not-a-path', 9223372036854775807n, '2026-08-30T00:00:00.000Z');
    const statement = database.prepare('SELECT byte_offset FROM rollout_cursors');
    statement.setReadBigInts(true);
    const row = statement.get();
    assert.equal(row.byte_offset, 9223372036854775807n);
    database.close();
    database = null;
    const reopened = openAgentDatabase(filename);
    try {
      assert.equal(scalar(reopened, 'SELECT COUNT(*) AS count FROM schema_migrations WHERE version=1 AND name=\'initial\'').count, 1);
      assert.equal(scalar(reopened, 'SELECT COUNT(*) AS count FROM rollout_cursors').count, 1);
      assert.throws(() => reopened.prepare(`INSERT INTO usage_outbox
        (event_id, occurred_at, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens, created_at)
        VALUES ('bad', '2026-08-30T00:00:00Z', 0, 0, 0, 0, 0, 9223372036854775808.0, '2026-08-30T00:00:00Z')`).run());
    } finally { reopened.close(); }
  });
});

test('server migration creates the complete M1 schema and indexes', async () => {
  await withDatabase('server', async (database) => {
    const tables = database.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(({ name }) => name);
    assert.deepEqual(tables, [
      'admin_auth', 'admin_sessions', 'device_enrollments', 'device_group_memberships', 'devices', 'groups', 'quota_current',
      'quota_snapshots', 'schema_migrations', 'server_settings', 'usage_adjustments', 'usage_events'
    ]);
    const indexes = database.prepare(`SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name`).all().map(({ name }) => name);
    for (const required of ['idx_memberships_device_interval', 'idx_usage_events_group_occurred', 'idx_usage_events_occurred']) {
      assert.equal(indexes.includes(required), true, required);
    }
  });
});

test('server foreign keys are enforced and migrations remain idempotent', async () => {
  await withDatabase('server', async (database, filename) => {
    assert.equal(scalar(database, 'PRAGMA journal_mode').journal_mode, 'wal');
    assert.equal(scalar(database, 'PRAGMA foreign_keys').foreign_keys, 1);
    assert.throws(() => database.prepare(`INSERT INTO devices
      (id, name, credential_hash, current_group_id, created_at, updated_at) VALUES ('orphan', 'orphan', 'hash', 'missing', 't', 't')`).run());
    database.prepare(`INSERT INTO groups (id, name, created_at, updated_at) VALUES ('g1', 'Group 1', 't', 't')`).run();
    database.prepare(`INSERT INTO devices (id, name, credential_hash, current_group_id, created_at, updated_at)
      VALUES ('d1', 'Device 1', 'hash', 'g1', 't', 't')`).run();
    database.prepare(`INSERT INTO device_group_memberships (id, device_id, group_id, valid_from)
      VALUES ('m1', 'd1', 'g1', '2026-08-30T00:00:00Z')`).run();
    assert.throws(() => database.prepare('DELETE FROM groups WHERE id = ?').run('g1'));
    database.close();
    database = null;
    const reopened = openServerDatabase(filename);
    try {
      assert.equal(scalar(reopened, 'SELECT COUNT(*) AS count FROM schema_migrations').count, 4);
      assert.equal(scalar(reopened, 'SELECT COUNT(*) AS count FROM groups').count, 1);
      assert.equal(scalar(reopened, 'PRAGMA foreign_keys').foreign_keys, 1);
    } finally { reopened.close(); }
  });
});

test('server token columns preserve signed 64-bit boundaries without Number coercion', async () => {
  await withDatabase('server', async (database) => {
    database.prepare(`INSERT INTO groups (id, name, created_at, updated_at) VALUES ('g', 'G', 't', 't')`).run();
    database.prepare(`INSERT INTO devices (id, name, credential_hash, current_group_id, created_at, updated_at)
      VALUES ('d', 'D', 'h', 'g', 't', 't')`).run();
    database.prepare(`INSERT INTO usage_events
      (id, device_id, event_id, occurred_at, received_at, resolved_group_id, input_tokens, cached_input_tokens,
       cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens)
      VALUES ('u', 'd', 'e', 't', 't', 'g', ?, 0, 0, 0, 0, ?)`).run(9007199254740993n, 9223372036854775807n);
    database.prepare(`INSERT INTO usage_adjustments
      (id, group_id, amount_tokens, reason, occurred_at, created_at) VALUES ('a', 'g', ?, 'correction', 't', 't')`).run(-9223372036854775808n);
    const eventStatement = database.prepare('SELECT input_tokens, total_tokens FROM usage_events');
    const adjustmentStatement = database.prepare('SELECT amount_tokens FROM usage_adjustments');
    eventStatement.setReadBigInts(true);
    adjustmentStatement.setReadBigInts(true);
    const event = eventStatement.get();
    const adjustment = adjustmentStatement.get();
    assert.deepEqual({ ...event }, { input_tokens: 9007199254740993n, total_tokens: 9223372036854775807n });
    assert.equal(adjustment.amount_tokens, -9223372036854775808n);
    assert.throws(() => database.prepare(`INSERT INTO usage_adjustments
      (id, amount_tokens, reason, occurred_at, created_at) VALUES ('zero', 0, 'bad', 't', 't')`).run());
  });
});
