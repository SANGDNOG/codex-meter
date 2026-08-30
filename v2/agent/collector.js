import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { discoverRollouts } from './discovery.js';
import { readCompleteLines, safeBaseline } from './reader.js';
import { createTelemetryParser } from '../shared/telemetry.js';
import { parseUnsignedInt64 } from '../shared/int64.js';

function now() { return new Date().toISOString(); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function transaction(database, callback) {
  database.exec('BEGIN IMMEDIATE');
  try { const result = callback(); database.exec('COMMIT'); return result; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }

/** Classify only explicit SessionMeta structure. Unknown/incomplete lineage is never treated as a root. */
export function classifyRollout(records) {
  const meta = records.find((record) => record?.type === 'session_meta');
  const payload = object(meta?.payload);
  if (!payload) return 'ambiguous';
  const source = payload.source;
  const sourceObject = object(source);
  const subagent = sourceObject ? (sourceObject.subagent ?? sourceObject.sub_agent ?? sourceObject.SubAgent) : undefined;
  const history = object(payload.history_base ?? payload.historyBase);
  const inheritedMarker = subagent !== undefined || history || payload.forked_from_id != null || payload.forkedFromId != null
    || payload.parent_thread_id != null || payload.parentThreadId != null;
  if (inheritedMarker) {
    // Explicit source variant or a complete history boundary is known inherited. Incomplete hints stay ambiguous.
    const completeHistory = history && Number.isSafeInteger(history.end_byte_offset ?? history.endByteOffset)
      && (history.end_byte_offset ?? history.endByteOffset) >= 0;
    const explicitSubagent = subagent !== undefined;
    return explicitSubagent || completeHistory ? 'inherited' : 'ambiguous';
  }
  if (source === undefined || source === null || typeof source === 'string') return 'root';
  return 'ambiguous';
}

function cursor(database, key) {
  return database.prepare('SELECT * FROM rollout_cursors WHERE rollout_key=?').get(key);
}
function putCursor(database, descriptor, values) {
  const rolloutKey = hash(descriptor.physicalIdentity);
  database.prepare(`INSERT INTO rollout_cursors
    (rollout_key,file_identity,byte_offset,updated_at,classification,discard_until_newline,model,reasoning_effort,malformed_lines,oversized_lines,partial_lines,last_path_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(rollout_key) DO UPDATE SET file_identity=excluded.file_identity,byte_offset=excluded.byte_offset,updated_at=excluded.updated_at,
      classification=excluded.classification,discard_until_newline=excluded.discard_until_newline,model=excluded.model,reasoning_effort=excluded.reasoning_effort,
      malformed_lines=rollout_cursors.malformed_lines+excluded.malformed_lines,oversized_lines=rollout_cursors.oversized_lines+excluded.oversized_lines,
      partial_lines=excluded.partial_lines,last_path_hash=excluded.last_path_hash`)
    .run(rolloutKey, rolloutKey, BigInt(values.offset), now(), values.classification,
      values.discardUntilNewline ? 1 : 0, values.model ?? null, values.reasoningEffort ?? null,
      values.malformedLines ?? 0, values.oversizedLines ?? 0, values.partialLines ?? 0, hash(descriptor.path));
}

export class AgentCollector {
  constructor(database, { home, discovery = discoverRollouts, clock = Date.now } = {}) {
    this.database = database; this.home = home; this.discovery = discovery; this.clock = clock;
  }

  async reconcile() {
    const discovery = await this.discovery({ home: this.home });
    const installed = this.database.prepare("SELECT value FROM agent_state WHERE key='installation_baselined'").get();
    if (!installed) {
      const baselines = [];
      for (const file of discovery.files) {
        try { baselines.push([file, await safeBaseline(file.path)]); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      transaction(this.database, () => {
        if (!this.database.prepare("SELECT 1 FROM agent_state WHERE key='installation_baselined'").get()) {
          for (const [file, base] of baselines) putCursor(this.database, file, { ...base, classification: 'baseline' });
          const timestamp = new Date(this.clock()).toISOString();
          for (const file of discovery.compressedFiles ?? []) this.database.prepare('INSERT OR IGNORE INTO agent_state(key,value,updated_at) VALUES(?,?,?)')
            .run(`compressed_baseline:${hash(file.physicalIdentity)}`, '1', timestamp);
          this.database.prepare("INSERT INTO agent_state(key,value,updated_at) VALUES('installation_baselined',?,?)").run(timestamp, timestamp);
        }
      });
      return { baseline: baselines.length, events: 0, files: discovery.files.length, compressedOnly: discovery.compressedOnly };
    }
    const compressedAt = new Date(this.clock()).toISOString();
    for (const file of discovery.compressedFiles ?? []) this.database.prepare('INSERT OR IGNORE INTO agent_state(key,value,updated_at) VALUES(?,?,?)')
      .run(`compressed_baseline:${hash(file.physicalIdentity)}`, '1', compressedAt);
    let events = 0;
    for (const file of discovery.files) events += await this.collectFile(file);
    return { baseline: 0, events, files: discovery.files.length, compressedOnly: discovery.compressedOnly };
  }

  async collectFile(descriptor) {
    const rolloutKey = hash(descriptor.physicalIdentity);
    let current = cursor(this.database, rolloutKey);
    if (!current) {
      const compressedKey = `compressed_baseline:${hash(descriptor.physicalIdentity)}`;
      if (this.database.prepare('SELECT 1 FROM agent_state WHERE key=?').get(compressedKey)) {
        const base = await safeBaseline(descriptor.path);
        transaction(this.database, () => {
          putCursor(this.database, descriptor, { ...base, classification: 'ambiguous' });
          this.database.prepare('DELETE FROM agent_state WHERE key=?').run(compressedKey);
        });
        return 0;
      }
      const probe = await readCompleteLines(descriptor.path, 0, { maxReadBytes: 8 * 1024 * 1024, maxLines: 256 });
      const classification = classifyRollout(probe.lines.map(({ record }) => record));
      if (classification !== 'root') {
        const base = await safeBaseline(descriptor.path);
        transaction(this.database, () => putCursor(this.database, descriptor, { ...base, classification }));
        return 0;
      }
      current = { byte_offset: 0, discard_until_newline: 0, classification, model: null, reasoning_effort: null };
    }
    let size;
    try { size = (await stat(descriptor.path)).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    if (BigInt(current.byte_offset) > BigInt(size)) {
      const base = await safeBaseline(descriptor.path);
      transaction(this.database, () => putCursor(this.database, descriptor, { ...base, classification: 'ambiguous' }));
      return 0;
    }
    const parsed = await readCompleteLines(descriptor.path, Number(current.byte_offset), {
      discardUntilNewline: Boolean(current.discard_until_newline), maxReadBytes: 8 * 1024 * 1024, maxLines: 10_000
    });
    if (parsed.disappeared) return 0;
    const parser = createTelemetryParser({ model: current.model, reasoningEffort: current.reasoning_effort });
    const additions = [];
    for (const line of parsed.lines) {
      const event = parser.parse(line.record);
      if (event) additions.push({ event, id: hash(`${descriptor.physicalIdentity}\0${line.start}\0${line.end}\0${JSON.stringify(event)}`) });
    }
    const finalContext = parser.context();
    transaction(this.database, () => {
      // Recheck prevents two watcher/reconcile passes from duplicating work.
      const latest = cursor(this.database, rolloutKey);
      const expected = BigInt(current.byte_offset);
      if (latest && BigInt(latest.byte_offset) !== expected) return;
      for (const { event, id } of additions) this.database.prepare(`INSERT OR IGNORE INTO usage_outbox
        (event_id,occurred_at,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,model,reasoning_effort,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, event.occurredAt, event.inputTokens == null ? null : parseUnsignedInt64(event.inputTokens),
          event.cachedInputTokens == null ? null : parseUnsignedInt64(event.cachedInputTokens), event.cacheWriteInputTokens == null ? null : parseUnsignedInt64(event.cacheWriteInputTokens),
          event.outputTokens == null ? null : parseUnsignedInt64(event.outputTokens), event.reasoningOutputTokens == null ? null : parseUnsignedInt64(event.reasoningOutputTokens),
          parseUnsignedInt64(event.totalTokens), event.model, event.reasoningEffort, new Date(this.clock()).toISOString());
      putCursor(this.database, descriptor, { offset: parsed.nextOffset, discardUntilNewline: parsed.discardUntilNewline,
        classification: current.classification, model: finalContext.model, reasoningEffort: finalContext.reasoningEffort, malformedLines: parsed.malformedLines,
        oversizedLines: parsed.oversizedLines, partialLines: parsed.partialLines });
    });
    return additions.length;
  }
}