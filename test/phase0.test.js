import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectRollouts } from '../tools/phase0/shared/rollout.js';
import { analyzeAccounting, buildLineage } from '../tools/phase0/shared/accounting.js';
import { streamJsonl } from '../tools/phase0/shared/jsonl.js';
import { AppServerClient, normalizeAccount, normalizeRateLimits } from '../tools/phase0/shared/app-server-client.js';
import { compareSnapshots } from '../tools/phase0/quota-snapshot.js';
import { calibrationInterval, finishObservation } from '../tools/phase0/calibration-recorder.js';
import { addTokens, subtractTokens } from '../tools/phase0/shared/core.js';
import { childPath, safeFilenameAtom } from '../tools/phase0/shared/sanitize.js';

const fixtures = path.join(import.meta.dirname, '..', 'tools', 'phase0', 'fixtures');
const secret = Buffer.alloc(32, 7); const fixed = '2026-01-02T00:00:00.000Z';
async function directory(names) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phase0-test-'));
  for (const name of names) await copyFile(path.join(fixtures, name), path.join(root, name));
  return root;
}
async function inspect(names) { return inspectRollouts({ root: await directory(names), secret, now: fixed, codexVersion: 'codex-cli test' }); }

test('phase0 simple fixture compares cumulative and last-usage strategies', async () => {
  const result = analyzeAccounting(await inspect(['simple-session.jsonl']), { now: fixed });
  assert.equal(result.strategies.naiveCumulative.totalTokens, 400);
  assert.equal(result.strategies.sumLastUsage.totalTokens, 400);
  assert.equal(result.strategies.lineageAware.totalTokens, 400);
});

test('phase0 fork fixture subtracts inherited child baseline only with explicit lineage', async () => {
  const inspection = await inspect(['fork-parent.jsonl', 'fork-child.jsonl']); const result = analyzeAccounting(inspection, { now: fixed });
  assert.equal(result.strategies.naiveCumulative.totalTokens, 2250);
  assert.equal(result.strategies.lineageAware.totalTokens, 1250);
  assert.equal(result.strategies.lineageAware.quality, 'high');
  const lineage = buildLineage(inspection, { now: fixed }); const child = lineage.nodes.find((node) => node.relation === 'fork');
  assert.equal(child.inheritedBaselineCandidate.total_tokens, 1000); assert.ok(child.parentId);
});

test('phase0 resumed duplicate logical session is not counted as a new cumulative file', async () => {
  const result = analyzeAccounting(await inspect(['resume-before.jsonl', 'resume-after.jsonl']), { now: fixed });
  assert.equal(result.strategies.naiveCumulative.totalTokens, 800);
  assert.equal(result.strategies.lineageAware.totalTokens, 500);
});

test('phase0 JSONL streaming survives malformed and partial lines', async () => {
  const result = await inspect(['malformed-partial.jsonl']);
  assert.equal(result.scan.malformedLines, 1); assert.equal(result.scan.partialFinalLines, 1); assert.equal(result.scan.records, 2);
  const missing = await streamJsonl(path.join(os.tmpdir(), `absent-${Date.now()}.jsonl`), () => {}); assert.equal(missing.disappeared, true);
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'phase0-large-')), 'large.jsonl'); await writeFile(file, `${'x'.repeat(100)}\n{}\n`);
  const stats = await streamJsonl(file, () => {}, { maxLineBytes: 20 }); assert.equal(stats.oversizedLines, 1); assert.equal(stats.records, 1);
});

test('phase0 unknown lineage is explicitly ambiguous', async () => {
  const result = analyzeAccounting(await inspect(['unknown-lineage.jsonl']), { now: fixed });
  assert.equal(result.strategies.lineageAware.quality, 'ambiguous'); assert.match(result.ambiguous[0], /no explicit parent/);
});

test('phase0 preserves all token dimensions without reasoning double count', async () => {
  const result = analyzeAccounting(await inspect(['multiple-dimensions.jsonl']), { now: fixed }); const raw = result.strategies.lineageAware.rawCounters;
  assert.deepEqual(raw, { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 30, reasoning_output_tokens: 12, total_tokens: 130 });
  assert.equal(result.strategies.lineageAware.totalTokens, 130); assert.match(result.tokenSemantics, /not added/);
});

test('phase0 rollout output uses an allowlist and leaks no adversarial content or paths', async () => {
  const result = await inspect(['privacy-adversarial.jsonl']); const text = JSON.stringify(result);
  for (const forbidden of ['SECRET_PROMPT_CONTENT', 'SECRET_RESPONSE_CONTENT', 'SECRET_TOOL_OUTPUT', 'SECRET_MODEL_CONTENT', 'SECRET_PARENT_CONTENT', 'SECRET_KEY', '/home/alice', '/very/private', '/private/source.js', 'privacy-a']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.match(text, /hmac:/); assert.equal(result.files[0].events.some((event) => event.totalUsage?.total_tokens === 6), true);
});

test('phase0 rate limits normalize actual durations and preserve opaque unknown IDs', () => {
  const value = normalizeRateLimits({ rateLimits: { limitId: 'legacy', primary: { windowDurationMins: 60, usedPercent: 1, resetsAt: 10 } }, rateLimitsByLimitId: {
    'opaque/new': { limitName: 'Unknown', planType: 'pro', secondary: { windowDurationMins: 10080, usedPercent: 68, resetsAt: 20 } }
  } });
  assert.equal(value.limits[0].limitId, 'opaque/new'); assert.deepEqual(value.limits[0].windows[0], { slot: 'secondary', durationMinutes: 10080, usedPercent: 68, resetsAt: 20 });
  assert.deepEqual(normalizeAccount({ account: { type: 'chatgpt', planType: 'pro', email: 'private@example.com', accessToken: 'secret' } }), { type: 'chatgpt', planType: 'pro' });
});

test('phase0 App Server client initializes first and isolates an unsupported read method', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phase0-server-')); const executable = path.join(root, 'fake-server');
  await writeFile(executable, `#!/usr/bin/env node\nconst rl=require('node:readline').createInterface({input:process.stdin});let initialized=false;rl.on('line',line=>{const x=JSON.parse(line);if(x.method==='initialize'){process.stdout.write(JSON.stringify({id:x.id,result:{}})+'\\n');return}if(x.method==='initialized'){initialized=true;return}if(!initialized)process.exit(9);if(x.method==='account/read')process.stdout.write(JSON.stringify({id:x.id,result:{account:{type:'chatgpt',planType:'test',email:'secret@example.com'}}})+'\\n');else process.stdout.write(JSON.stringify({id:x.id,error:{code:-32601,message:'Method not found'}})+'\\n')})\n`); await chmod(executable, 0o700);
  const client = new AppServerClient({ command: executable, timeoutMs: 2000 }); await client.start();
  assert.equal((await client.request('account/read', { refreshToken: false })).account.planType, 'test');
  await assert.rejects(() => client.request('account/usage/read'), /failed|found/i); await assert.rejects(async () => client.request('thread/start'), /refusing/); await client.close();
});

test('phase0 quota comparison reports differences and makes no scope proof', () => {
  const base = { timestamp: fixed, deviceLabel: 'a', quota: { limits: [{ limitId: 'x', limitName: 'X', planType: 'pro', windows: [{ slot: 'primary', durationMinutes: 60, usedPercent: 10, resetsAt: 20 }] }] } };
  const same = compareSnapshots(base, { ...base, deviceLabel: 'b' }, fixed); assert.match(same.assessment, /does not prove/);
  const changed = structuredClone(base); changed.deviceLabel = 'b'; changed.quota.limits[0].windows[0].usedPercent = 11;
  assert.equal(compareSnapshots(base, changed, fixed).differences[0].field, 'usedPercent');
  const empty = { timestamp: fixed, deviceLabel: 'empty', planType: 'pro', quota: { limits: [] } };
  assert.match(compareSnapshots(empty, { ...empty, deviceLabel: 'other' }, fixed).assessment, /insufficient/);
});

test('phase0 multiple disconnected session roots remain accounting-ambiguous', async () => {
  const result = analyzeAccounting(await inspect(['simple-session.jsonl', 'multiple-dimensions.jsonl']), { now: fixed });
  assert.equal(result.strategies.lineageAware.quality, 'ambiguous');
  assert.match(result.ambiguous.at(-1), /multiple unconnected session roots/);
});

test('phase0 calibration preserves quantized displays without claiming an estimator', () => {
  const before = { observationId: 'test-1', startedAt: '2026-01-01T00:00:00.000Z', context: {}, quotaBefore: {
    quota: { limits: [{ limitId: 'opaque', windows: [{ slot: 'primary', durationMinutes: 60, usedPercent: 25, resetsAt: 100 }] }] }
  } };
  const after = { codexVersion: 'test', planType: 'plus', quota: { limits: [{ limitId: 'opaque', windows: [{ slot: 'primary', durationMinutes: 60, usedPercent: 25, resetsAt: 100 }] }] } };
  const result = finishObservation(before, after, { total_tokens: 100 }, '2026-01-01T00:01:00.000Z');
  assert.equal(result.quota[0].displayedPercentChange, 0);
  assert.equal(result.quota[0].experimentalTokensPerDisplayedPoint, null);
  assert.equal(result.estimator, null);
  assert.match(result.quality.notes[0], /unchanged does not prove zero cost/);
});

test('phase0 generated filenames reject traversal and stay inside the output directory', () => {
  for (const unsafe of ['../outside', '..', '.', '/absolute', 'a/b', 'a\\b']) assert.equal(safeFilenameAtom(unsafe), null);
  assert.equal(safeFilenameAtom('device-01.test'), 'device-01.test');
  const root = path.resolve('/tmp/phase0-safe-output');
  assert.equal(childPath(root, 'device-01.json'), path.join(root, 'device-01.json'));
  assert.throws(() => childPath(root, '../outside.json'), /escapes/);
});

test('phase0 token arithmetic preserves missing dimensions as null', () => {
  const known = { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 14 };
  const partial = { ...known, input_tokens: null, total_tokens: null };
  assert.equal(addTokens(known, partial).input_tokens, null);
  assert.equal(addTokens(partial, known).total_tokens, null);
  assert.equal(subtractTokens(known, partial).input_tokens, null);
  assert.equal(subtractTokens(partial, known).total_tokens, null);
});

test('phase0 partial child baseline and calibration delta remain incomplete', () => {
  const known = { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 14 };
  const baseline = { ...known, input_tokens: null, total_tokens: null };
  const inspection = { codexVersion: 'test', scan: { droppedEvents: 0 }, files: [
    { fileId: 'parent-file', events: [{ sessionId: 'parent', totalUsage: known }] },
    { fileId: 'child-file', events: [{ sessionId: 'child', forkedFromId: 'parent', totalUsage: baseline }, { sessionId: 'child', forkedFromId: 'parent', totalUsage: known }] }
  ] };
  const result = analyzeAccounting(inspection, { now: fixed });
  assert.equal(result.strategies.lineageAware.rawCounters.input_tokens, null);
  assert.equal(result.strategies.lineageAware.rawCounters.total_tokens, null);
  assert.equal(subtractTokens(known, baseline).total_tokens, null);
});

test('phase0 cumulative counter regression is explicitly ambiguous', () => {
  const tokens = (total, input = total) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total });
  const inspection = { codexVersion: 'test', scan: { droppedEvents: 0 }, files: [{ fileId: 'f', events: [
    { sessionId: 's', totalUsage: tokens(100, 80) }, { sessionId: 's', totalUsage: tokens(90, 85) }
  ] }] };
  const result = analyzeAccounting(inspection, { now: fixed });
  assert.equal(result.strategies.lineageAware.quality, 'ambiguous');
  assert.match(result.ambiguous.join('\n'), /regressed.*total_tokens/);
});

test('phase0 calibration marks cross-snapshot regressions unknown and ambiguous', () => {
  const tokens = (total) => ({ input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total });
  const interval = calibrationInterval(tokens(90), tokens(100));
  assert.deepEqual(interval.regressedFields, ['input_tokens', 'total_tokens']);
  assert.equal(interval.usage.input_tokens, null); assert.equal(interval.usage.total_tokens, null);
  const pending = { observationId: 'regression', startedAt: '2026-01-01T00:00:00.000Z', context: {}, quotaBefore: { quota: { limits: [] } } };
  const after = { codexVersion: 'test', planType: 'plus', quota: { limits: [] } };
  const result = finishObservation(pending, after, interval.usage, '2026-01-01T00:01:00.000Z', 'ambiguous', interval.regressedFields);
  assert.equal(result.quality.localUsageQuality, 'ambiguous'); assert.equal(result.quality.confidence, 'low');
  assert.match(result.quality.notes.join('\n'), /regressed.*unknown/i);
});

test('phase0 raw session IDs still pseudonymize file paths without crashing', async () => {
  const root = await directory(['simple-session.jsonl']);
  const result = await inspectRollouts({ root, rawIds: true, secret, now: fixed, codexVersion: 'test' });
  assert.equal(result.pseudonymizedSessionIds, false);
  assert.match(result.files[0].fileId, /^hmac:/);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('phase0 unavailable cumulative observations are explicitly ambiguous', () => {
  const result = analyzeAccounting({ codexVersion: 'test', scan: { droppedEvents: 0 }, files: [] }, { now: fixed });
  assert.equal(result.strategies.lineageAware.quality, 'ambiguous');
  assert.equal(result.strategies.lineageAware.totalTokens, null);
  assert.match(result.ambiguous.join('\n'), /no cumulative token observations/);
});
