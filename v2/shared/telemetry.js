import { parseUnsignedInt64 } from './int64.js';

const TOKEN_FIELDS = Object.freeze({
  input_tokens: 'inputTokens',
  cached_input_tokens: 'cachedInputTokens',
  cache_write_input_tokens: 'cacheWriteInputTokens',
  output_tokens: 'outputTokens',
  reasoning_output_tokens: 'reasoningOutputTokens',
  total_tokens: 'totalTokens'
});
const SAFE_METADATA = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function metadata(value) {
  return typeof value === 'string' && SAFE_METADATA.test(value) ? value : null;
}

function timestamp(value) {
  let date;
  if (Number.isSafeInteger(value) && value >= 0) date = new Date(value * 1000);
  else if (typeof value === 'string' && value.length <= 35 && /^\d{4}-\d{2}-\d{2}T/.test(value)) date = new Date(value);
  else return null;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function token(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('unsafe token number');
    value = String(value);
  }
  return parseUnsignedInt64(value).toString();
}

function contextRecord(record) {
  const payload = plainObject(record?.payload);
  if (!payload || (record.type !== 'session_meta' && record.type !== 'turn_context')) return null;
  const settings = plainObject(plainObject(payload.collaboration_mode)?.settings);
  const update = {};
  const hasModel = Object.hasOwn(payload, 'model') || (settings && Object.hasOwn(settings, 'model'));
  const hasEffort = ['reasoning_effort', 'reasoningEffort', 'effort'].some((key) => Object.hasOwn(payload, key))
    || (settings && ['reasoning_effort', 'reasoningEffort'].some((key) => Object.hasOwn(settings, key)));
  if (hasModel) update.model = metadata(payload.model) ?? metadata(settings?.model);
  if (hasEffort) update.reasoningEffort = metadata(payload.reasoning_effort ?? payload.reasoningEffort ?? payload.effort)
    ?? metadata(settings?.reasoning_effort ?? settings?.reasoningEffort);
  return update;
}

function usageEvent(record, context) {
  const payload = plainObject(record?.payload);
  const info = plainObject(payload?.info);
  const usage = plainObject(info?.last_token_usage);
  if (record?.type !== 'event_msg' || payload?.type !== 'token_count' || !usage) return null;
  const occurredAt = timestamp(record.timestamp);
  if (!occurredAt || !Object.hasOwn(usage, 'total_tokens')) return null;
  const result = { occurredAt };
  try {
    for (const [wireName, outputName] of Object.entries(TOKEN_FIELDS)) {
      result[outputName] = Object.hasOwn(usage, wireName) ? token(usage[wireName]) : null;
    }
  } catch {
    return null;
  }
  result.model = context.model;
  result.reasoningEffort = context.reasoningEffort;
  return result;
}

export function createTelemetryParser(initialContext = {}) {
  let context = {
    model: metadata(initialContext.model),
    reasoningEffort: metadata(initialContext.reasoningEffort)
  };
  return Object.freeze({
    parse(record) {
      const next = contextRecord(record);
      if (next) {
        context = { ...context, ...next };
        return null;
      }
      return usageEvent(record, context);
    },
    context() { return Object.freeze({ ...context }); }
  });
}

export function parseTelemetryRecord(record, context = {}) {
  return usageEvent(record, {
    model: metadata(context.model),
    reasoningEffort: metadata(context.reasoningEffort)
  });
}
