import path from 'node:path';
import os from 'node:os';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { AGENT_CAPABILITY_HEADER, AGENT_CAPABILITY_HEADER_VALUE, parseServerCapabilities } from '../shared/capabilities.js';

export const AGENT_VERSION = '2.1.0-dev';
export function defaultStateDirectory() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexMeter');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Codex Meter');
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'codex-meter');
}
export function defaultConfigPath() { return path.join(defaultStateDirectory(), 'agent.json'); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
const PROFILE_MARKER = '.codex-meter-profile.json';
function accountId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid profile accountId');
  return value;
}
function safeHome(value) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n\u2028\u2029]/u.test(value)) throw new Error('invalid profile codexHome');
  return path.resolve(value);
}
function safeExecutable(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n\u2028\u2029]/u.test(value)) throw new Error('codexExecutable must be an absolute path');
  return path.normalize(value);
}
function validUrl(raw, allowHttp) {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new Error('serverUrl must not contain credentials, query, or fragment');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && loopback)) throw new Error('serverUrl must use HTTPS (HTTP is test-only and loopback-only)');
  return url.href.replace(/\/$/, '');
}
export function validateConfig(value) {
  if (!plain(value)) throw new Error('invalid agent configuration');
  const allowed = new Set(['serverUrl','deviceId','deviceSecret','codexHome','codexExecutable','profiles','databasePath','reconcileIntervalMs','syncIntervalMs','heartbeatIntervalMs','maxBatchSize','allowHttpForTests']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('unknown agent configuration field');
  const allowHttpForTests = value.allowHttpForTests === true;
  if (typeof value.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.deviceId)) throw new Error('invalid deviceId');
  if (typeof value.deviceSecret !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(value.deviceSecret)) throw new Error('invalid deviceSecret');
  const interval = (name, fallback, min = 100) => value[name] === undefined ? fallback :
    (Number.isInteger(value[name]) && value[name] >= min && value[name] <= 86_400_000 ? value[name] : (() => { throw new Error(`invalid ${name}`); })());
  const maxBatchSize = value.maxBatchSize ?? 100;
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 100) throw new Error('invalid maxBatchSize');
  let profiles = [];
  if (value.profiles !== undefined) {
    if (!Array.isArray(value.profiles) || value.profiles.length > 64) throw new Error('invalid profiles');
    profiles = value.profiles.map((profile) => {
      if (!plain(profile) || Object.keys(profile).some((key) => !['accountId','name','codexHome','codexExecutable'].includes(key))) throw new Error('invalid profile');
      accountId(profile.accountId);
      if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 200) throw new Error('invalid profile name');
      const codexHome = safeHome(profile.codexHome);
      return Object.freeze({ accountId: profile.accountId, name: profile.name.trim(), codexHome,
        ...(profile.codexExecutable === undefined ? {} : { codexExecutable: safeExecutable(profile.codexExecutable) }) });
    });
    if (new Set(profiles.map((profile) => profile.accountId)).size !== profiles.length) throw new Error('duplicate profile accountId');
    const homes = profiles.map((profile) => process.platform === 'win32' ? profile.codexHome.toLowerCase() : profile.codexHome);
    if (new Set(homes).size !== homes.length) throw new Error('profile codexHome reuse is not allowed');
    for (let left = 0; left < homes.length; left += 1) for (let right = left + 1; right < homes.length; right += 1) {
      const relative = path.relative(homes[left], homes[right]);
      const reverse = path.relative(homes[right], homes[left]);
      if ((relative && !relative.startsWith('..') && !path.isAbsolute(relative)) || (reverse && !reverse.startsWith('..') && !path.isAbsolute(reverse)))
        throw new Error('profile codexHome roots must not overlap');
    }
  }
  const state = defaultStateDirectory();
  return Object.freeze({ serverUrl: validUrl(value.serverUrl, allowHttpForTests), deviceId: value.deviceId, deviceSecret: value.deviceSecret,
    codexHome: path.resolve(value.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    ...(value.codexExecutable === undefined ? {} : { codexExecutable: safeExecutable(value.codexExecutable) }), profiles: Object.freeze(profiles),
    databasePath: path.resolve(value.databasePath || path.join(state, 'agent.db')), reconcileIntervalMs: interval('reconcileIntervalMs', 30_000),
    syncIntervalMs: interval('syncIntervalMs', 15_000), heartbeatIntervalMs: interval('heartbeatIntervalMs', 60_000), maxBatchSize, allowHttpForTests });
}

/** Initialize only the profile root and credential-store setting. auth.json is never accessed. */
export async function initializeManagedHome(codexHome, profileAccountId) {
  const owner = accountId(profileAccountId); const home = safeHome(codexHome);
  try { const info=await lstat(home);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('managed CODEX_HOME must be a real directory, not a symbolic link'); }
  catch(error){if(error.code!=='ENOENT')throw error;await mkdir(home,{recursive:true,mode:0o700});}
  const homeInfo=await lstat(home);if(homeInfo.isSymbolicLink()||!homeInfo.isDirectory())throw new Error('managed CODEX_HOME must be a real directory, not a symbolic link');
  const markerPath = path.join(home, PROFILE_MARKER);
  try {
    const markerInfo=await lstat(markerPath);
    if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) throw new Error('managed profile marker must be a regular file, not a symbolic link');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!plain(marker) || Object.keys(marker).sort().join(',') !== 'accountId,version' || marker.version !== 1 || marker.accountId !== owner)
      throw new Error('CODEX_HOME is owned by a different Account Profile');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const configPath = path.join(home, 'config.toml');
  try { const configInfo=await lstat(configPath);if(configInfo.isSymbolicLink()||!configInfo.isFile())throw new Error('managed config.toml must be a regular file, not a symbolic link'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let contents;
  try { contents = await readFile(configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (contents !== undefined) {
    let parsed;
    try { parsed = parseToml(contents); }
    catch { throw new Error('cannot safely parse managed config.toml'); }
    const hasCredentialStore = Object.prototype.hasOwnProperty.call(parsed, 'cli_auth_credentials_store');
    if (hasCredentialStore && parsed.cli_auth_credentials_store !== 'file')
      throw new Error('conflicting cli_auth_credentials_store in config.toml');
    if (!hasCredentialStore) {
      const temporary = `${configPath}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, `cli_auth_credentials_store = \"file\"\n${contents}`, { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') await chmod(temporary, 0o600);
        await rename(temporary, configPath);
      } catch (error) { await rm(temporary, { force: true }); throw error; }
    }
  } else {
    const handle = await open(configPath, 'wx', 0o600);
    try { await handle.write('cli_auth_credentials_store = \"file\"\n'); } finally { await handle.close(); }
  }
  try {
    const handle = await open(markerPath, 'wx', 0o600);
    try { await handle.write(`${JSON.stringify({ version: 1, accountId: owner })}\n`); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (!plain(marker) || marker.version !== 1 || marker.accountId !== owner) throw new Error('CODEX_HOME is owned by a different Account Profile');
  }
  if (process.platform !== 'win32') await chmod(home, 0o700);
  if (process.platform !== 'win32') await chmod(markerPath, 0o600);
  if (process.platform !== 'win32') await chmod(configPath, 0o600);
  return { codexHome: home, configPath, markerPath };
}

export function profileLauncher(profile, platform = process.platform) {
  if (!profile?.codexHome) throw new Error('profile is required'); const home=safeHome(profile.codexHome);
  const executable=profile.codexExecutable===undefined?'codex':safeExecutable(profile.codexExecutable);
  if (platform === 'win32') return `$hadCodexHome = Test-Path Env:CODEX_HOME\n$previousCodexHome = $env:CODEX_HOME\n$codexExitCode = 0\ntry {\n  $env:CODEX_HOME = '${home.replaceAll("'", "''")}'\n  $global:LASTEXITCODE = $null\n  & '${executable.replaceAll("'", "''")}' @args\n  $commandSucceeded = $?\n  $nativeExitCode = $LASTEXITCODE\n  if ($null -ne $nativeExitCode) { $codexExitCode = $nativeExitCode } elseif (-not $commandSucceeded) { $codexExitCode = 1 }\n} finally {\n  if ($hadCodexHome) { $env:CODEX_HOME = $previousCodexHome } else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }\n}\nexit $codexExitCode\n`;
  return `#!/bin/sh\nexport CODEX_HOME='${home.replaceAll("'", "'\"'\"'")}'\nexec '${executable.replaceAll("'", "'\"'\"'")}' \"$@\"\n`;
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
export async function enroll({ serverUrl, token, configPath = defaultConfigPath(), allowHttpForTests = false, codexHome: home, codexExecutable, databasePath } = {}) {
  const base = validUrl(serverUrl, allowHttpForTests);
  const response = await fetch(`${base}/api/v1/agent/enroll`, { method: 'POST', headers: { 'content-type': 'application/json',[AGENT_CAPABILITY_HEADER]:AGENT_CAPABILITY_HEADER_VALUE }, body: JSON.stringify({ token }) });
  if (!response.ok) throw new Error(`enrollment failed (${response.status})`);
  const result = await response.json();
  const serverCapabilities=parseServerCapabilities(result.serverCapabilities);
  if(serverCapabilities===null)throw new Error('enrollment returned invalid Server capabilities');
  const remote = result.agentConfiguration ?? {};
  const config=await saveConfig(configPath, { serverUrl: result.serverUrl || base, deviceId: result.deviceId, deviceSecret: result.deviceSecret,
    codexHome: home, codexExecutable, databasePath, allowHttpForTests, syncIntervalMs: remote.syncIntervalSeconds ? remote.syncIntervalSeconds * 1000 : undefined,
    heartbeatIntervalMs: remote.heartbeatIntervalSeconds ? remote.heartbeatIntervalSeconds * 1000 : undefined,
    maxBatchSize: Math.min(remote.maxBatchSize ?? 100, 100) });
  return{config,desiredConfiguration:serverCapabilities&&remote.schemaVersion===1?remote:null};
}
