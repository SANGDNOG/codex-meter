import path from 'node:path';
import os from 'node:os';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

export const AGENT_VERSION = '2.0.0';
export function defaultStateDirectory() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexMeter');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Codex Meter');
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'codex-meter');
}
export function defaultConfigPath() { return path.join(defaultStateDirectory(), 'agent.json'); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function validUrl(raw, allowHttp) {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new Error('serverUrl must not contain credentials, query, or fragment');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && loopback)) throw new Error('serverUrl must use HTTPS (HTTP is test-only and loopback-only)');
  return url.href.replace(/\/$/, '');
}
export function validateConfig(value) {
  if (!plain(value)) throw new Error('invalid agent configuration');
  const allowed = new Set(['serverUrl','deviceId','deviceSecret','codexHome','databasePath','reconcileIntervalMs','syncIntervalMs','heartbeatIntervalMs','maxBatchSize','allowHttpForTests']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('unknown agent configuration field');
  const allowHttpForTests = value.allowHttpForTests === true;
  if (typeof value.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.deviceId)) throw new Error('invalid deviceId');
  if (typeof value.deviceSecret !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(value.deviceSecret)) throw new Error('invalid deviceSecret');
  const interval = (name, fallback, min = 100) => value[name] === undefined ? fallback :
    (Number.isInteger(value[name]) && value[name] >= min && value[name] <= 86_400_000 ? value[name] : (() => { throw new Error(`invalid ${name}`); })());
  const maxBatchSize = value.maxBatchSize ?? 100;
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 100) throw new Error('invalid maxBatchSize');
  const state = defaultStateDirectory();
  return Object.freeze({ serverUrl: validUrl(value.serverUrl, allowHttpForTests), deviceId: value.deviceId, deviceSecret: value.deviceSecret,
    codexHome: path.resolve(value.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    databasePath: path.resolve(value.databasePath || path.join(state, 'agent.db')), reconcileIntervalMs: interval('reconcileIntervalMs', 30_000),
    syncIntervalMs: interval('syncIntervalMs', 15_000), heartbeatIntervalMs: interval('heartbeatIntervalMs', 60_000), maxBatchSize, allowHttpForTests });
}
async function requireProtected(filename) {
  if (process.platform === 'win32') return;
  const info = await stat(filename);
  if ((info.mode & 0o077) !== 0) throw new Error('agent config permissions are too broad; require mode 0600');
}
export async function loadConfig(filename = defaultConfigPath()) {
  await requireProtected(filename);
  return validateConfig(JSON.parse(await readFile(filename, 'utf8')));
}
export async function saveConfig(filename, value) {
  const config = validateConfig(value); const directory = path.dirname(path.resolve(filename));
  await mkdir(directory, { recursive: true, mode: 0o700 }); if (process.platform !== 'win32') await chmod(directory, 0o700);
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, filename); return config;
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
export async function enroll({ serverUrl, token, configPath = defaultConfigPath(), allowHttpForTests = false, codexHome: home, databasePath } = {}) {
  const base = validUrl(serverUrl, allowHttpForTests);
  const response = await fetch(`${base}/api/v1/agent/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!response.ok) throw new Error(`enrollment failed (${response.status})`);
  const result = await response.json();
  const remote = result.agentConfiguration ?? {};
  return saveConfig(configPath, { serverUrl: result.serverUrl || base, deviceId: result.deviceId, deviceSecret: result.deviceSecret,
    codexHome: home, databasePath, allowHttpForTests, syncIntervalMs: remote.syncIntervalSeconds ? remote.syncIntervalSeconds * 1000 : undefined,
    heartbeatIntervalMs: remote.heartbeatIntervalSeconds ? remote.heartbeatIntervalSeconds * 1000 : undefined,
    maxBatchSize: Math.min(remote.maxBatchSize ?? 100, 100) });
}
