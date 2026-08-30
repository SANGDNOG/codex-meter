import { AGENT_VERSION } from './config.js';
import { QuotaReporter } from './app-server.js';

const COLUMNS = ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const WIRE = ['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];

function outboxRows(database, limit) {
  const statement = database.prepare('SELECT * FROM usage_outbox ORDER BY sequence LIMIT ?');
  statement.setReadBigInts(true);
  return statement.all(limit);
}
function wire(row) {
  const event = { eventId: row.event_id, occurredAt: row.occurred_at, model: row.model, reasoningEffort: row.reasoning_effort };
  for (let i = 0; i < COLUMNS.length; i++) event[WIRE[i]] = row[COLUMNS[i]] == null ? null : row[COLUMNS[i]].toString();
  return event;
}
function state(database, key, value, clock) {
  const at = new Date(clock()).toISOString();
  database.prepare(`INSERT INTO agent_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), at);
}

export class AgentSyncClient {
  constructor(database, config, { fetchImpl = fetch, clock = Date.now, codexVersion = null, timeoutMs = 30_000, quotaReporter } = {}) {
    this.database = database; this.config = config; this.fetch = fetchImpl; this.clock = clock; this.codexVersion = codexVersion; this.timeoutMs = timeoutMs;
    this.quotaReporter = quotaReporter ?? new QuotaReporter({ clock });
  }
  pending() { return this.database.prepare('SELECT COUNT(*) count FROM usage_outbox').get().count; }
  async sync({ heartbeat = false, health = { status: 'healthy' } } = {}) {
    const rows = outboxRows(this.database, this.config.maxBatchSize);
    const designated = this.database.prepare("SELECT value FROM agent_state WHERE key='is_quota_reporter'").get()?.value === 'true';
    if (!rows.length && !heartbeat && !designated) return { skipped: true, pending: 0 };
    const quotaReport = designated ? await this.quotaReporter.observe() : undefined;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetch(`${this.config.serverUrl}/api/v1/agent/sync`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.deviceId}.${this.config.deviceSecret}` },
        body: JSON.stringify({ agentVersion: AGENT_VERSION, codexVersion: this.codexVersion, events: rows.map(wire), health,
          ...(quotaReport === undefined ? {} : { quotaReport }) })
      });
    } catch (error) {
      state(this.database, 'last_sync_status', 'unavailable', this.clock);
      throw new Error('agent sync unavailable', { cause: error });
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      state(this.database, 'last_sync_status', `http_${response.status}`, this.clock);
      if (response.status === 403 && designated) state(this.database, 'is_quota_reporter', false, this.clock);
      throw new Error(`agent sync failed (${response.status})`);
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('agent sync returned invalid JSON'); }
    const sent = new Set(rows.map((row) => row.event_id));
    const acknowledged = new Set([...(Array.isArray(result.acceptedEventIds) ? result.acceptedEventIds : []),
      ...(Array.isArray(result.duplicateEventIds) ? result.duplicateEventIds : [])].filter((id) => sent.has(id)));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.database.prepare('DELETE FROM usage_outbox WHERE event_id=?');
      for (const id of acknowledged) remove.run(id);
      state(this.database, 'last_sync_status', 'ok', this.clock);
      state(this.database, 'last_sync_at', new Date(this.clock()).toISOString(), this.clock);
      if (result.serverTime) state(this.database, 'last_server_time', result.serverTime, this.clock);
      state(this.database, 'is_quota_reporter', result.isQuotaReporter === true, this.clock);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return { sent: rows.length, acknowledged: acknowledged.size, pending: this.pending(), configuration: result.agentConfiguration ?? null,
      isQuotaReporter: result.isQuotaReporter === true };
  }
}