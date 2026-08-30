import path from 'node:path';
import { streamJsonl } from './jsonl.js';
import { cleanTokens, metadata, getCodexVersion, TOKEN_FIELDS } from './core.js';
import { idValue, loadProbeSecret, safeAtom, safeMetadataAtom, safeTimestamp } from './sanitize.js';
import { discoverRollouts } from './paths.js';

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function directValue(root, keys) {
  root = object(root); if (!root) return null;
  for (const key of keys) if (Object.hasOwn(root, key) && (typeof root[key] === 'string' || typeof root[key] === 'number')) return root[key];
  return null;
}
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function usageFromRecord(record, key) {
  const info = record?.type === 'event_msg' && record?.payload?.type === 'token_count' ? object(record.payload.info) : null;
  const value = object(info?.[key]); return value ? cleanTokens(value) : null;
}
function zeroUsage(value) {
  if (!value) return false;
  const observed = TOKEN_FIELDS.filter((key) => value[key] != null);
  return observed.length > 0 && observed.every((key) => value[key] === 0);
}
function rateWindow(slot, value) {
  value = object(value); if (!value) return null;
  const duration = value.window_minutes ?? value.windowMinutes ?? value.window_duration_mins ?? value.windowDurationMins ?? value.durationMinutes;
  const used = value.used_percent ?? value.usedPercent;
  return {
    slot,
    durationMinutes: Number.isSafeInteger(duration) && duration >= 0 ? duration : null,
    usedPercent: typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 ? used : null,
    resetsAt: safeTimestamp(value.resets_at ?? value.resetsAt)
  };
}
/** Local structural sanitizer for protocol::RateLimitSnapshot. */
export function normalizeTokenCountRateLimits(value) {
  value = object(value); if (!value) return null;
  const windows = [];
  for (const slot of ['primary', 'secondary']) { const item = rateWindow(slot, value[slot]); if (item) windows.push(item); }
  const credits = object(value.credits);
  const individual = object(value.individual_limit ?? value.individualLimit);
  const result = {
    limitId: safeAtom(value.limit_id ?? value.limitId),
    limitName: safeAtom(value.limit_name ?? value.limitName),
    planType: safeAtom(value.plan_type ?? value.planType),
    windows,
    credits: credits ? {
      hasCredits: typeof (credits.has_credits ?? credits.hasCredits) === 'boolean' ? (credits.has_credits ?? credits.hasCredits) : null,
      unlimited: typeof credits.unlimited === 'boolean' ? credits.unlimited : null,
      balance: typeof credits.balance === 'string' && /^\d+(?:\.\d+)?$/.test(credits.balance) ? credits.balance : null
    } : null,
    individualLimit: individual ? {
      limit: typeof individual.limit === 'string' && /^\d+(?:\.\d+)?$/.test(individual.limit) ? individual.limit : null,
      used: typeof individual.used === 'string' && /^\d+(?:\.\d+)?$/.test(individual.used) ? individual.used : null,
      remainingPercent: Number.isSafeInteger(individual.remaining_percent ?? individual.remainingPercent) ? (individual.remaining_percent ?? individual.remainingPercent) : null,
      resetsAt: safeTimestamp(individual.resets_at ?? individual.resetsAt)
    } : null,
    spendControlReached: typeof (value.spend_control_reached ?? value.spendControlReached) === 'boolean' ? (value.spend_control_reached ?? value.spendControlReached) : null,
    rateLimitReachedType: safeMetadataAtom(value.rate_limit_reached_type ?? value.rateLimitReachedType)
  };
  return Object.values(result).some((item) => item != null && (!Array.isArray(item) || item.length)) ? result : null;
}
function structuredSource(payload, options) {
  const source = payload.source;
  if (typeof source === 'string') return { source: safeMetadataAtom(source), sourceRelation: null };
  const sourceObject = object(source);
  if (!sourceObject) return { source: safeMetadataAtom(payload.thread_source), sourceRelation: null };
  // serde's externally-tagged SessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... }).
  const subagentValue = sourceObject.subagent ?? sourceObject.sub_agent ?? sourceObject.SubAgent;
  if (typeof subagentValue === 'string') return { source: safeMetadataAtom(`subagent_${subagentValue}`), sourceRelation: null };
  const subagent = object(subagentValue);
  if (!subagent) return { source: null, sourceRelation: null };
  const spawn = object(subagent.thread_spawn ?? subagent.ThreadSpawn);
  if (spawn) return {
    source: 'subagent_thread_spawn',
    sourceRelation: {
      type: 'subagent',
      parentId: idValue(directValue(spawn, ['parent_thread_id', 'parentThreadId']), options),
      depth: nonnegativeInteger(spawn.depth)
    }
  };
  const variant = Object.keys(subagent).find((key) => ['review', 'compact', 'memory_consolidation', 'other'].includes(key));
  return { source: variant ? safeMetadataAtom(`subagent_${variant}`) : 'subagent', sourceRelation: null };
}
function physicalRolloutId(filename, options) {
  // Current canonical name ends in a UUID rollout identity before .jsonl[.zst].
  const name = path.basename(filename).replace(/\.jsonl(?:\.zst)?$/, '');
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return idValue(match?.[1] ?? null, options);
}
function extractRecord(record, options, fallbackOrdinal) {
  if (!object(record)) return null;
  const outer = safeMetadataAtom(record.type); const inner = safeMetadataAtom(record.payload?.type);
  const eventType = inner ? `${outer || 'record'}:${inner}` : outer;
  const totalUsage = usageFromRecord(record, 'total_token_usage');
  const lastUsage = usageFromRecord(record, 'last_token_usage');
  const payload = object(record.payload) || {};
  const isMetadata = record.type === 'session_meta' || record.type === 'turn_context';
  const isSessionMeta = record.type === 'session_meta';
  // SessionMeta.session_id and SessionMeta.id have distinct semantics as of upstream 6478a751.
  const sessionRaw = isMetadata ? directValue(payload, ['session_id', 'sessionId']) : null;
  const threadRaw = isSessionMeta ? directValue(payload, ['id', 'thread_id', 'threadId']) : directValue(payload, ['thread_id', 'threadId']);
  const sessionId = idValue(sessionRaw ?? (isSessionMeta ? threadRaw : null), options); // legacy fixture fallback only
  const threadId = idValue(threadRaw ?? (isSessionMeta ? sessionRaw : null), options);
  const parentThreadId = idValue(isMetadata ? directValue(payload, ['parent_thread_id', 'parentThreadId']) : null, options);
  const forkedFromId = idValue(isMetadata ? directValue(payload, ['forked_from_id', 'forkedFromId']) : null, options);
  const history = isSessionMeta ? object(payload.history_base ?? payload.historyBase) : null;
  const historyBase = history ? {
    rolloutId: idValue(directValue(history, ['thread_id', 'threadId', 'rollout_id', 'rolloutId']), options),
    endOrdinalExclusive: nonnegativeInteger(history.end_ordinal_exclusive ?? history.endOrdinalExclusive),
    endByteOffset: nonnegativeInteger(history.end_byte_offset ?? history.endByteOffset)
  } : null;
  const sourceData = isSessionMeta ? structuredSource(payload, options) : { source: null, sourceRelation: null };
  const settings = object(payload.collaboration_mode)?.settings;
  const context = {
    model: safeMetadataAtom(isMetadata ? directValue(payload, ['model']) ?? directValue(settings, ['model']) : null),
    reasoningEffort: safeMetadataAtom(isMetadata ? directValue(payload, ['reasoning_effort', 'reasoningEffort', 'effort']) ?? directValue(settings, ['reasoning_effort', 'reasoningEffort']) : null),
    serviceTier: safeMetadataAtom(isMetadata ? directValue(payload, ['service_tier', 'serviceTier', 'speed_tier', 'speedTier']) : null),
    source: sourceData.source
  };
  const timestamp = safeTimestamp(record.timestamp ?? (isMetadata ? directValue(payload, ['timestamp', 'created_at', 'createdAt']) : null));
  const currentForkCutoff = nonnegativeInteger(payload.forked_from_ordinal_exclusive ?? payload.forkedFromOrdinalExclusive);
  const legacyForkCutoff = nonnegativeInteger(payload.fork_ordinal ?? payload.forkOrdinal);
  const forkedFromOrdinalExclusive = currentForkCutoff ?? legacyForkCutoff;
  const forkCutoffKind = currentForkCutoff != null ? 'exclusive' : legacyForkCutoff != null ? 'legacy' : null;
  const subagentHistoryStartOrdinal = nonnegativeInteger(payload.subagent_history_start_ordinal ?? payload.subagentHistoryStartOrdinal);
  const rolloutOrdinal = nonnegativeInteger(record.ordinal) ?? fallbackOrdinal;
  const tokenCount = record.type === 'event_msg' && payload.type === 'token_count';
  const rateLimitsPresent = tokenCount ? Object.hasOwn(payload, 'rate_limits') && payload.rate_limits != null : null;
  const rateLimits = rateLimitsPresent ? normalizeTokenCountRateLimits(payload.rate_limits) : null;
  if (!eventType && !timestamp && !totalUsage && !lastUsage && !sessionId && !threadId && !parentThreadId && !forkedFromId && !Object.values(context).some(Boolean)) return null;
  return { eventType, timestamp, rolloutOrdinal, sessionId, threadId, parentThreadId, forkedFromId,
    forkedFromOrdinalExclusive, forkCutoffKind, historyBase, subagentHistoryStartOrdinal, sourceRelation: sourceData.sourceRelation,
    ...context, totalUsage, lastUsage, initialLastUsageZero: tokenCount ? zeroUsage(lastUsage) : null,
    rateLimitsPresent, rateLimits };
}

export async function inspectRollouts({ root, home, rawIds = false, secret, secretFile, now, codexVersion, maxEventsPerFile = 10000, maxEventsTotal = 100000 } = {}) {
  secret ||= await loadProbeSecret(secretFile);
  const discovery = await discoverRollouts({ root: root || null, home: home || null });
  const summaries = [];
  const totals = { records: 0, malformedLines: 0, partialFinalLines: 0, oversizedLines: 0, disappeared: 0, retainedEvents: 0, droppedEvents: 0 };
  for (const descriptor of discovery.files) {
    const filename = descriptor.path; const events = []; let droppedEvents = 0; let ordinal = 0;
    const fileId = idValue(filename, { rawIds: false, secret });
    const rolloutId = physicalRolloutId(filename, { rawIds, secret });
    const stats = await streamJsonl(filename, (record) => {
      const safe = extractRecord(record, { rawIds, secret }, ordinal++);
      if (!safe) return;
      if (events.length < maxEventsPerFile && totals.retainedEvents < maxEventsTotal) { events.push(safe); totals.retainedEvents++; }
      else { droppedEvents++; totals.droppedEvents++; }
    });
    for (const key of ['records', 'malformedLines', 'partialFinalLines', 'oversizedLines']) totals[key] += stats[key];
    totals.disappeared += Number(stats.disappeared);
    summaries.push({ fileId, rolloutId, archived: descriptor.archived, stats: { ...stats, retainedEvents: events.length, droppedEvents }, events });
  }
  const scan = { ...totals, compressedRolloutsDetected: discovery.compressedRolloutsDetected,
    compressedRolloutCount: discovery.compressedRolloutCount, compressedOnlyRolloutCount: discovery.compressedOnlyRolloutCount,
    archivedRolloutsDetected: discovery.archivedRolloutsDetected, archivedRolloutCount: discovery.archivedRolloutCount,
    scanCompleteness: discovery.scanCompleteness };
  return { ...metadata('rollout-inspector', now, codexVersion ?? await getCodexVersion()), sessionsLocation: discovery.files.length || discovery.compressedRolloutsDetected ? 'detected' : 'not_found_or_empty',
    pseudonymizedSessionIds: !rawIds, compressedRolloutsDetected: discovery.compressedRolloutsDetected,
    archivedRolloutsDetected: discovery.archivedRolloutsDetected, scanCompleteness: discovery.scanCompleteness,
    retention: { maxEventsPerFile, maxEventsTotal, truncated: totals.droppedEvents > 0 }, files: summaries, scan };
}
