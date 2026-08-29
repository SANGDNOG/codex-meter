import { streamJsonl } from './jsonl.js';
import { cleanTokens, metadata, getCodexVersion } from './core.js';
import { idValue, loadProbeSecret, safeMetadataAtom, safeTimestamp } from './sanitize.js';
import { jsonlFiles, sessionsRoot } from './paths.js';

const ID_KEYS = Object.freeze({
  sessionId: ['session_id', 'sessionId', 'thread_id', 'threadId'],
  parentThreadId: ['parent_thread_id', 'parentThreadId', 'parent_id', 'parentId'],
  forkedFromId: ['forked_from_id', 'forkedFromId', 'forked_from', 'forkedFrom'],
  subagentParentId: ['subagent_parent_id', 'subagentParentId', 'agent_parent_id', 'agentParentId']
});
const CONTEXT_KEYS = Object.freeze({
  model: ['model'], reasoningEffort: ['reasoning_effort', 'reasoningEffort'],
  serviceTier: ['service_tier', 'serviceTier', 'speed_tier', 'speedTier'], source: ['source', 'session_source', 'sessionSource']
});
function directValue(root, keys) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  for (const key of keys) if (Object.hasOwn(root, key) && (typeof root[key] === 'string' || typeof root[key] === 'number')) return root[key];
  return null;
}
function usageFromRecord(record, key) {
  const info = record?.type === 'event_msg' && record?.payload?.type === 'token_count' ? record.payload.info : null;
  const value = info?.[key]; return value && typeof value === 'object' ? cleanTokens(value) : null;
}
function extractRecord(record, options) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const outer = safeMetadataAtom(record.type); const inner = safeMetadataAtom(record.payload?.type);
  const eventType = inner ? `${outer || 'record'}:${inner}` : outer;
  const totalUsage = usageFromRecord(record, 'total_token_usage');
  const lastUsage = usageFromRecord(record, 'last_token_usage');
  // Metadata extraction is structural, never a recursive key search. A prompt or
  // tool payload can itself contain keys such as "model" or "parent_id".
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) ? record.payload : {};
  const isMetadata = record.type === 'session_meta' || record.type === 'turn_context';
  const ids = {};
  for (const [name, keys] of Object.entries(ID_KEYS)) ids[name] = idValue(isMetadata ? directValue(payload, keys) : null, options);
  if (!ids.sessionId && record.type === 'session_meta') ids.sessionId = idValue(payload.id, options);
  if (!ids.sessionId && record.type === 'turn_context') ids.sessionId = idValue(payload.thread_id ?? payload.threadId, options);
  const settings = payload.collaboration_mode?.settings;
  const context = {
    model: safeMetadataAtom(isMetadata ? directValue(payload, CONTEXT_KEYS.model) ?? directValue(settings, CONTEXT_KEYS.model) : null),
    reasoningEffort: safeMetadataAtom(isMetadata ? directValue(payload, [...CONTEXT_KEYS.reasoningEffort, 'effort']) ?? directValue(settings, CONTEXT_KEYS.reasoningEffort) : null),
    serviceTier: safeMetadataAtom(isMetadata ? directValue(payload, CONTEXT_KEYS.serviceTier) : null),
    source: safeMetadataAtom(record.type === 'session_meta' ? directValue(payload, [...CONTEXT_KEYS.source, 'thread_source']) : null)
  };
  const timestamp = safeTimestamp(record.timestamp ?? (isMetadata ? directValue(payload, ['timestamp', 'created_at', 'createdAt']) : null));
  const forkOrdinalRaw = isMetadata ? directValue(payload, ['fork_ordinal', 'forkOrdinal']) : null;
  const forkOrdinal = Number.isSafeInteger(forkOrdinalRaw) && forkOrdinalRaw >= 0 ? forkOrdinalRaw : null;
  if (!eventType && !timestamp && !totalUsage && !lastUsage && !Object.values(ids).some(Boolean) && !Object.values(context).some(Boolean)) return null;
  return { eventType, timestamp, ...ids, forkOrdinal, ...context, totalUsage, lastUsage };
}
export async function inspectRollouts({ root, rawIds = false, secret, secretFile, now, codexVersion, maxEventsPerFile = 10000, maxEventsTotal = 100000 } = {}) {
  // File paths are always pseudonymized, including raw session-ID mode.
  secret ||= await loadProbeSecret(secretFile);
  const files = await jsonlFiles(root || sessionsRoot());
  const summaries = [];
  const totals = { records: 0, malformedLines: 0, partialFinalLines: 0, oversizedLines: 0, disappeared: 0, retainedEvents: 0, droppedEvents: 0 };
  for (const filename of files) {
    const events = [];
    let droppedEvents = 0;
    const fileId = idValue(filename, { rawIds: false, secret }); // Never expose a path, even in raw-ID mode.
    const stats = await streamJsonl(filename, (record) => {
      const safe = extractRecord(record, { rawIds, secret });
      if (!safe) return;
      if (events.length < maxEventsPerFile && totals.retainedEvents < maxEventsTotal) { events.push(safe); totals.retainedEvents++; }
      else { droppedEvents++; totals.droppedEvents++; }
    });
    for (const key of ['records', 'malformedLines', 'partialFinalLines', 'oversizedLines']) totals[key] += stats[key];
    totals.disappeared += Number(stats.disappeared);
    summaries.push({ fileId, stats: { ...stats, retainedEvents: events.length, droppedEvents }, events });
  }
  return { ...metadata('rollout-inspector', now, codexVersion ?? await getCodexVersion()), sessionsLocation: files.length ? 'detected' : 'not_found_or_empty', pseudonymizedSessionIds: !rawIds,
    retention: { maxEventsPerFile, maxEventsTotal, truncated: totals.droppedEvents > 0 }, files: summaries, scan: totals };
}
