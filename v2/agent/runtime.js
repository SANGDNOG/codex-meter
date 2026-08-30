import { watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AgentCollector } from './collector.js';
import { AgentSyncClient } from './sync.js';
import { AGENT_VERSION } from './config.js';

function delay(ms) { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }); }
function setState(database, key, value) {
  const at = new Date().toISOString();
  database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, value, at);
}
export class AgentRuntime {
  constructor(database, config, options = {}) {
    this.database = database; this.config = config;
    this.collector = options.collector ?? new AgentCollector(database, { home: config.codexHome });
    this.syncClient = options.syncClient ?? new AgentSyncClient(database, config, options);
    this.running = false; this.watchers = []; this.reconciling = null; this.syncing = null; this.backoffMs = 1000; this.nextSyncAt = 0;
  }
  async reconcile() {
    if (!this.reconciling) this.reconciling = this.collector.reconcile()
      .then((result) => { setState(this.database, 'last_collect_status', 'healthy'); return result; })
      .catch((error) => { setState(this.database, 'last_collect_status', 'degraded'); throw error; })
      .finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  async sync(heartbeat = false) {
    if (Date.now() < this.nextSyncAt) return { skipped: true, backoff: true, retryAt: new Date(this.nextSyncAt).toISOString() };
    const health = { status: this.database.prepare("SELECT value FROM agent_state WHERE key='last_collect_status'").get()?.value === 'degraded' ? 'degraded' : 'healthy' };
    if (!this.syncing) this.syncing = this.syncClient.sync({ heartbeat, health }).then((result) => { this.backoffMs = 1000; this.nextSyncAt = 0; return result; })
      .catch((error) => { this.nextSyncAt = Date.now() + this.backoffMs; this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000); throw error; })
      .finally(() => { this.syncing = null; });
    return this.syncing;
  }
  trigger() { this.reconcile().then(() => this.sync()).catch(() => {}); }
  async start() {
    if (this.running) return; this.running = true;
    await mkdir(this.config.codexHome, { recursive: true });
    await this.reconcile();
    for (const directory of [this.config.codexHome, path.join(this.config.codexHome, 'sessions'), path.join(this.config.codexHome, 'archived_sessions')]) {
      try { this.watchers.push(watch(directory, { persistent: directory === this.config.codexHome }, () => this.trigger())); } catch { /* reconciliation is authoritative */ }
    }
    this.loops = [this.loop(this.config.reconcileIntervalMs, () => this.reconcile()),
      this.loop(this.config.syncIntervalMs, () => this.sync()), this.loop(this.config.heartbeatIntervalMs, () => this.sync(true))];
  }
  async loop(interval, action) {
    while (this.running) {
      await delay(interval); if (!this.running) break;
      try { await action(); } catch { /* sync applies exponential retry gating; reconciliation retries periodically */ }
    }
  }
  async stop() {
    this.running = false; for (const watcher of this.watchers) watcher.close(); this.watchers = [];
    await Promise.allSettled([this.reconciling, this.syncing].filter(Boolean));
  }
}

export function agentStatus(database, config) {
  const states = Object.fromEntries(database.prepare('SELECT key,value,updated_at FROM agent_state').all().map((row) => [row.key, { value: row.value, updatedAt: row.updated_at }]));
  const cursorStats = database.prepare(`SELECT COUNT(*) files,coalesce(SUM(malformed_lines),0) malformedLines,
    coalesce(SUM(oversized_lines),0) oversizedLines,coalesce(SUM(partial_lines),0) partialFiles FROM rollout_cursors`).get();
  return { agentVersion: AGENT_VERSION, deviceId: config.deviceId, serverUrl: config.serverUrl, running: states.runtime_status?.value === 'running',
    outboxPending: database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count, cursors: cursorStats, states };
}