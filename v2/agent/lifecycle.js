import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MANIFEST_PATH = '/api/v1/agent/releases/manifest.json';
export const SERVICE_NAME = 'codex-meter-agent';

export function releaseTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const targets = { 'linux-x64': 'linux-x64', 'darwin-arm64': 'macos-arm64', 'win32-x64': 'windows-x64' };
  if (!targets[key]) throw new Error(`unsupported platform: ${platform}/${arch}`);
  return targets[key];
}

export function validateManifest(value, target) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.version !== 'string' || !value.version) throw new Error('invalid release manifest');
  const artifact = value.artifacts?.[target];
  if (!artifact || typeof artifact.url !== 'string' || !artifact.url || typeof artifact.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(artifact.sha256)) throw new Error(`release manifest has no valid artifact for ${target}`);
  return { version: value.version, url: artifact.url, sha256: artifact.sha256.toLowerCase() };
}

export function lifecyclePaths(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'linux') {
    const state = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'codex-meter');
    return { platform, executable: path.join(home, '.local', 'bin', 'codex-meter-agent'), config: path.join(state, 'agent.json'), state,
      service: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'codex-meter-agent.service') };
  }
  if (platform === 'darwin') {
    const state = path.join(home, 'Library', 'Application Support', 'Codex Meter');
    return { platform, executable: path.join(state, 'codex-meter-agent'), config: path.join(state, 'agent.json'), state,
      service: path.join(home, 'Library', 'LaunchAgents', 'com.codex-meter.agent.plist') };
  }
  if (platform === 'win32') {
    const state = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodexMeter');
    return { platform, executable: path.join(state, 'codex-meter-agent.exe'), config: path.join(state, 'agent.json'), state, task: 'Codex Meter Agent' };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
export function systemdUnit(executable, config) {
  return `[Unit]\nDescription=Codex Meter Agent\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${JSON.stringify(executable)} run --config ${JSON.stringify(config)}\nRestart=on-failure\nRestartSec=5\nEnvironment=CODEX_METER_EXECUTABLE=${JSON.stringify(executable)}\n\n[Install]\nWantedBy=default.target\n`;
}
export function launchAgentPlist(executable, config) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.codex-meter.agent</string>\n<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>run</string><string>--config</string><string>${xml(config)}</string></array>\n<key>EnvironmentVariables</key><dict><key>CODEX_METER_EXECUTABLE</key><string>${xml(executable)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(path.join(path.dirname(config), 'agent.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(path.dirname(config), 'agent-error.log'))}</string>\n</dict></plist>\n`;
}
export function windowsTaskCommand(executable, config) {
  return `"${executable}" run --config "${config}"`;
}

export async function fetchVerifiedArtifact({ serverUrl, target = releaseTarget(), fetchImpl = fetch, destination }) {
  const manifestUrl = new URL(MANIFEST_PATH, `${serverUrl.replace(/\/$/, '')}/`);
  const response = await fetchImpl(manifestUrl);
  if (!response.ok) throw new Error(`release manifest download failed (${response.status})`);
  const artifact = validateManifest(await response.json(), target);
  const artifactUrl = new URL(artifact.url, manifestUrl);
  const binaryResponse = await fetchImpl(artifactUrl);
  if (!binaryResponse.ok) throw new Error(`agent artifact download failed (${binaryResponse.status})`);
  const bytes = Buffer.from(await binaryResponse.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.sha256) throw new Error('agent artifact checksum mismatch; existing installation was not changed');
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o700 });
  if (process.platform !== 'win32') await chmod(destination, 0o700);
  return artifact;
}

function defaultRun(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'ignore', windowsHide: true });
    let output = ''; if (options.capture) child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)));
  });
}

export async function serviceStatus(paths = lifecyclePaths(), run = defaultRun) {
  try {
    if (paths.platform === 'linux') { const output = await run('systemctl', ['--user', 'is-active', SERVICE_NAME], { capture: true }); return { service: output.trim() || 'active' }; }
    if (paths.platform === 'darwin') { await run('launchctl', ['print', `gui/${process.getuid()}/com.codex-meter.agent`], { capture: true }); return { service: 'active' }; }
    await run('schtasks.exe', ['/Query', '/TN', paths.task]); return { service: 'registered' };
  } catch { return { service: 'inactive' }; }
}

export async function updateInstalledAgent(config, { paths = lifecyclePaths(), fetchImpl = fetch, run = defaultRun, platform = process.platform, pid = process.pid } = {}) {
  const executable = process.env.CODEX_METER_EXECUTABLE || paths.executable;
  const temporary = `${executable}.update-${pid}`;
  await rm(temporary, { force: true });
  let artifact;
  try { artifact = await fetchVerifiedArtifact({ serverUrl: config.serverUrl, target: releaseTarget(platform, process.arch), fetchImpl, destination: temporary }); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  if (platform === 'win32') {
    const helper = `${executable}.replace-${pid}.cmd`;
    const script = `@echo off\r\n:wait\r\ntasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL && (ping 127.0.0.1 -n 2 >NUL & goto wait)\r\nmove /Y "${temporary}" "${executable}" >NUL || exit /b 1\r\nschtasks.exe /Run /TN "${paths.task}" >NUL 2>&1\r\ndel "%~f0"\r\n`;
    await writeFile(helper, script, { mode: 0o600 });
    await run('cmd.exe', ['/d', '/c', 'start', '""', '/b', helper]);
    return { version: artifact.version, update: 'scheduled' };
  }
  await rename(temporary, executable);
  if (paths.platform === 'linux') await run('systemctl', ['--user', 'restart', SERVICE_NAME]);
  else await run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.codex-meter.agent`]);
  return { version: artifact.version, update: 'installed' };
}

export async function uninstallInstalledAgent(configPath, config, { paths = lifecyclePaths(), run = defaultRun } = {}) {
  if (paths.platform === 'linux') {
    try { await run('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]); } catch {}
    await rm(paths.service, { force: true }); try { await run('systemctl', ['--user', 'daemon-reload']); } catch {}
  } else if (paths.platform === 'darwin') {
    try { await run('launchctl', ['bootout', `gui/${process.getuid()}`, paths.service]); } catch {}
    await rm(paths.service, { force: true });
  } else { try { await run('schtasks.exe', ['/Delete', '/TN', paths.task, '/F']); } catch {} }
  await rm(config.databasePath, { force: true }); await rm(`${config.databasePath}-wal`, { force: true }); await rm(`${config.databasePath}-shm`, { force: true });
  await rm(configPath, { force: true });
  const executable = process.env.CODEX_METER_EXECUTABLE || paths.executable;
  if (paths.platform === 'win32') {
    // Keep the helper outside the application directory so it can remove the running executable after this process exits.
    const helper = path.join(os.tmpdir(), `codex-meter-uninstall-${process.pid}.cmd`);
    await writeFile(helper, `@echo off\r\n:wait\r\ntasklist /FI "PID eq ${process.pid}" 2>NUL | find "${process.pid}" >NUL && (ping 127.0.0.1 -n 2 >NUL & goto wait)\r\ndel /F /Q "${executable}"\r\ndel "%~f0"\r\n`, { mode: 0o600 });
    await run('cmd.exe', ['/d', '/c', 'start', '""', '/b', helper]);
  } else {
    await rm(executable, { force: true });
  }
  return { uninstalled: true };
}

export async function executableExists(filename) { try { await access(filename); return (await stat(filename)).isFile(); } catch { return false; } }
