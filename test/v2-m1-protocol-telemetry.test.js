import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INT64_MAX,
  INT64_MIN,
  addDecimalStrings,
  parseSignedInt64,
  parseUnsignedInt64,
  toDecimalString
} from '../v2/shared/int64.js';
import { createTelemetryParser, parseTelemetryRecord } from '../v2/shared/telemetry.js';

test('decimal-string protocol is canonical and safe across signed 64-bit boundaries', () => {
  assert.equal(parseUnsignedInt64('0'), 0n);
  assert.equal(parseUnsignedInt64('9223372036854775807'), INT64_MAX);
  assert.equal(parseSignedInt64('-9223372036854775808'), INT64_MIN);
  assert.equal(toDecimalString(INT64_MAX), '9223372036854775807');
  assert.equal(addDecimalStrings('9007199254740992', '1'), '9007199254740993');
  for (const value of [0, 1, 9007199254740991, 1n, null, undefined, '01', '+1', '-0', ' 1', '1.0', '1e3', '']) {
    assert.throws(() => parseUnsignedInt64(value), { name: 'TypeError' });
  }
  assert.throws(() => parseUnsignedInt64('9223372036854775808'), RangeError);
  assert.throws(() => parseSignedInt64('-9223372036854775809'), RangeError);
  assert.throws(() => addDecimalStrings('9223372036854775807', '1'), RangeError);
});

test('telemetry parser accepts only token_count lastUsage and never totalUsage', () => {
  const parser = createTelemetryParser();
  assert.equal(parser.parse({ type: 'session_meta', payload: { model: 'gpt-5', reasoning_effort: 'high' } }), null);
  const event = parser.parse({
    timestamp: '2026-08-30T12:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: '9007199254740993', cached_input_tokens: 4, cache_write_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 9 },
      total_token_usage: { input_tokens: 999999, total_tokens: 999999 }
    } }
  });
  assert.deepEqual(event, {
    occurredAt: '2026-08-30T12:00:00.000Z', inputTokens: '9007199254740993', cachedInputTokens: '4',
    cacheWriteInputTokens: '2', outputTokens: '3', reasoningOutputTokens: '1', totalTokens: '9',
    model: 'gpt-5', reasoningEffort: 'high'
  });
  assert.equal(parser.parse({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5 } } } }), null);
});

test('telemetry parser preserves absent dimensions as null and does not derive or double-add totals', () => {
  const event = parseTelemetryRecord({ timestamp: 1788091200, type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 4, reasoning_output_tokens: 3, total_tokens: 14 }
  } } });
  assert.deepEqual(event, {
    occurredAt: '2026-08-30T12:00:00.000Z', inputTokens: '10', cachedInputTokens: '8', cacheWriteInputTokens: null,
    outputTokens: '4', reasoningOutputTokens: '3', totalTokens: '14', model: null, reasoningEffort: null
  });
});

test('adversarial content and lookalikes cannot cross the telemetry allowlist', () => {
  const secret = 'LEAK-ME-7d30f52b';
  const parser = createTelemetryParser();
  parser.parse({ type: 'session_meta', payload: {
    model: 'gpt-safe', reasoning_effort: 'medium', cwd: secret, path: secret,
    messages: [{ model: secret }], source: { model: secret }, arbitrary: secret
  } });
  const output = parser.parse({
    timestamp: '2026-08-30T12:00:00Z', type: 'event_msg', model: secret, reasoning_effort: secret,
    payload: { type: 'token_count', prompt: secret, response: secret, tool_arguments: secret, tool_output: secret,
      info: { last_token_usage: { total_tokens: 1, prompt: secret, model: secret },
        lastUsage: { total_tokens: 999, source_code: secret }, total_token_usage: { total_tokens: 888, cwd: secret } } }
  });
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(Object.keys(output).sort(), [
    'cacheWriteInputTokens', 'cachedInputTokens', 'inputTokens', 'model', 'occurredAt',
    'outputTokens', 'reasoningEffort', 'reasoningOutputTokens', 'totalTokens'
  ].sort());
  assert.equal(output.totalTokens, '1');
  assert.equal(output.model, 'gpt-safe');
});

test('invalid token dimensions, timestamps, and unsafe metadata reject the whole event', () => {
  const base = { timestamp: '2026-08-30T12:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 1 } } } };
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '9223372036854775808']) {
    assert.equal(parseTelemetryRecord({ ...base, payload: { ...base.payload, info: { last_token_usage: { total_tokens: bad } } } }), null);
  }
  assert.equal(parseTelemetryRecord({ ...base, timestamp: 'not-a-time' }), null);
  const parser = createTelemetryParser();
  parser.parse({ type: 'session_meta', payload: { model: 'contains space', reasoning_effort: 'high' } });
  assert.equal(parser.parse(base)?.model, null);
});
