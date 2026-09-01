#!/usr/bin/env node
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { AppServerClient } from './shared/app-server-client.js';
import { getCodexVersion, metadata } from './shared/core.js';
import { loadProbeSecret } from './shared/sanitize.js';
import { assertNoUnknown, option, printJson, writeJson } from './shared/output.js';

const CANDIDATE_NAMESPACES = new Map([
  ['accountId', 'accountId'], ['account_id', 'accountId'],
  ['userId', 'userId'], ['user_id', 'userId'],
  ['workspaceId', 'workspaceId'], ['workspace_id', 'workspaceId'],
  ['organizationId', 'organizationId'], ['organization_id', 'organizationId'],
  ['orgId', 'organizationId'], ['org_id', 'organizationId']
]);
const AUTH_TYPES = new Set(['chatgpt', 'apiKey', 'api_key']);
const PLAN_TYPES = new Set(['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu']);
const SAFE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function candidateValue(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 160) return null;
  if (/[@\s]/.test(value) || /^eyJ[A-Za-z0-9_-]*\./.test(value) || (value.match(/\./g)?.length ?? 0) >= 2) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return null;
  return value;
}

function fingerprint(namespace, value, secret) {
  return `hmac:${crypto.createHmac('sha256', secret).update(`codex-meter-phase0\0${namespace}\0${value}`).digest('hex').slice(0, 24)}`;
}

export function sanitizeAccountIdentity(result, secret) {
  const account = result?.account;
  if (!account || typeof account !== 'object' || Array.isArray(account) || !Buffer.isBuffer(secret) || secret.length < 16) {
    return { status: 'malformed_response', account: { authType: null, planType: null }, accountFieldSchema: [], candidates: [] };
  }
  const accountFieldSchema = Object.keys(account)
    .filter((name) => SAFE_FIELD_NAME.test(name))
    .sort()
    .slice(0, 64)
    .map((name) => ({ name, type: valueType(account[name]) }));
  const candidates = [];
  for (const [name, namespace] of CANDIDATE_NAMESPACES) {
    if (!Object.hasOwn(account, name)) continue;
    const value = candidateValue(account[name]);
    if (!value) continue;
    candidates.push({ path: `account.${name}`, namespace, fingerprint: fingerprint(namespace, value, secret) });
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const rawAuthType = account.type ?? account.authType ?? account.auth_type;
  const rawPlanType = account.planType ?? account.plan_type;
  const authType = typeof rawAuthType === 'string' && AUTH_TYPES.has(rawAuthType) ? rawAuthType : null;
  const planType = typeof rawPlanType === 'string' && PLAN_TYPES.has(rawPlanType.toLowerCase()) ? rawPlanType.toLowerCase() : null;
  const status = candidates.length === 0 ? 'no_safe_candidate' : candidates.length === 1 ? 'candidate_observed' : 'ambiguous_candidates';
  return { status, account: { authType, planType }, accountFieldSchema, candidates };
}

export function assessRepeatedIdentity(observations) {
  if (!Array.isArray(observations) || observations.length === 0) return { status: 'no_observations', namespace: null, fingerprint: null, observations: 0 };
  if (observations.some((item) => item?.status === 'malformed_response')) return { status: 'malformed_response', namespace: null, fingerprint: null, observations: observations.length };
  const failed = observations.filter((item) => item?.status === 'request_failed').length;
  if (failed === observations.length) return { status: 'request_failed', namespace: null, fingerprint: null, observations: observations.length };
  if (failed > 0) return { status: 'incomplete_observations', namespace: null, fingerprint: null, observations: observations.length };
  if (observations.some((item) => item?.candidates?.length > 1)) return { status: 'ambiguous_candidates', namespace: null, fingerprint: null, observations: observations.length };
  const candidates = observations.map((item) => item?.candidates?.[0]).filter(Boolean);
  if (candidates.length !== observations.length) return { status: 'no_safe_candidate', namespace: null, fingerprint: null, observations: observations.length };
  const namespaces = new Set(candidates.map((item) => item.namespace));
  const fingerprints = new Set(candidates.map((item) => item.fingerprint));
  if (namespaces.size !== 1 || fingerprints.size !== 1) return { status: 'unstable_candidate', namespace: null, fingerprint: null, observations: observations.length };
  return { status: 'stable_candidate', namespace: candidates[0].namespace, fingerprint: candidates[0].fingerprint, observations: observations.length };
}

async function authBoundary(filename = path.join(os.homedir(), '.codex', 'auth.json')) {
  try {
    const value = await stat(filename);
    return { present: true, mode: (value.mode & 0o777).toString(8).padStart(4, '0'), size: value.size, mtimeNs: value.mtimeNs?.toString() ?? String(Math.trunc(value.mtimeMs * 1e6)) };
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, mode: null, size: null, mtimeNs: null };
    return { present: null, mode: null, size: null, mtimeNs: null };
  }
}

export async function runAccountIdentityProbe({ command, timeoutMs = 10_000, iterations = 3, secretFile, now = new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 2 || iterations > 10) throw new Error('iterations must be 2..10');
  const secret = await loadProbeSecret(secretFile);
  const before = await authBoundary();
  const observations = [];
  for (let index = 0; index < iterations; index++) {
    const client = new AppServerClient({ command, timeoutMs });
    let observation;
    try {
      await client.start();
      const raw = await client.request('account/read', { refreshToken: false });
      observation = { sequence: index + 1, ...sanitizeAccountIdentity(raw, secret) };
    } catch {
      observation = { sequence: index + 1, status: 'request_failed', account: { authType: null, planType: null }, accountFieldSchema: [], candidates: [] };
    } finally {
      const lifecycle = await client.close();
      observation = { ...observation, processExitedAfterObservation: lifecycle.exited, forcedTermination: lifecycle.forced };
    }
    observations.push(observation);
  }
  const after = await authBoundary();
  const processRestartedBetweenObservations = observations.length === iterations && observations.every((item) => item.processExitedAfterObservation === true);
  return {
    ...metadata('account-identity', now, await getCodexVersion(command)),
    platform: `${process.platform}-${process.arch}`,
    observations,
    repeatedIdentity: assessRepeatedIdentity(observations),
    processRestartedBetweenObservations,
    authBoundary: { before, after, metadataChanged: JSON.stringify(before) !== JSON.stringify(after), contentsRead: false },
    rawResponsesPersisted: false
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2); assertNoUnknown(args, ['--output', '--secret-file', '--timeout-ms', '--iterations']);
    const timeoutMs = Number(option(args, '--timeout-ms', '10000'));
    const iterations = Number(option(args, '--iterations', '3'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('--timeout-ms must be 100..60000');
    const output = option(args, '--output');
    const secretFile = option(args, '--secret-file', path.resolve('phase0-output/.account-identity-secret'));
    const result = await runAccountIdentityProbe({ timeoutMs, iterations, secretFile });
    if (output) await writeJson(output, result);
    printJson(result);
  } catch (error) {
    console.error(`phase0 account identity probe: ${error.message}`);
    process.exitCode = 2;
  }
}
