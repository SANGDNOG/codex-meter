#!/usr/bin/env node
import os from 'node:os'; import path from 'node:path'; import { readFile } from 'node:fs/promises';
import { addUsage, scanSessions, snapshotDelta, zeroUsage } from '../lib/usage.js';
import { meterApi, replaySpool, spoolUpdate, acquireClientLock, isPermanentMeterError } from '../lib/client.js'; import { spawnCodex } from '../lib/command.js';

const home = process.env.CODEX_METER_HOME || path.join(os.homedir(), '.codex-meter');
let config;
try { config = JSON.parse((await readFile(path.join(home, 'client.json'), 'utf8')).replace(/^\uFEFF/, '')); } catch { console.error(`Missing/invalid ${path.join(home, 'client.json')}`); process.exit(78); }
const pollIntervalMs = Number(config.pollIntervalMs ?? 5000);
if (typeof config.serverUrl !== 'string' || !config.serverUrl || typeof config.meterToken !== 'string' || !config.meterToken || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000) { console.error('client.json requires string serverUrl/meterToken and pollIntervalMs from 1000 to 60000'); process.exit(78); }
try { new URL(config.serverUrl); } catch { console.error('client.json serverUrl must be a valid URL'); process.exit(78); }
let releaseClientLock;
try { releaseClientLock = await acquireClientLock(home); }
catch (e) { console.error(e.message); process.exit(73); }
async function exit(code) { try { await releaseClientLock(); } catch (e) { console.error(`Meter lock cleanup warning: ${e.message}`); } process.exit(code); }
const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'); const spoolDir = path.join(home, 'spool');
await replaySpool(spoolDir, (x) => x.finish ? meterApi.finish(config.serverUrl, config.meterToken, x.leaseId, x.usage) : meterApi.update(config.serverUrl, config.meterToken, x.leaseId, x.usage));
let lease;
try { lease = await meterApi.start(config.serverUrl, config.meterToken); } catch (e) { console.error(`Meter denied start: ${e.data?.error || e.message}`); await exit(e.status === 403 || e.status === 409 ? 77 : 69); }
let previous; let absolute = zeroUsage(); let child;
async function closeFailedStart(exitCode, message) {
  console.error(message);
  const item = { leaseId: lease.leaseId, usage: absolute, finish: true };
  try { await meterApi.finish(config.serverUrl, config.meterToken, lease.leaseId, absolute); }
  catch { try { await spoolUpdate(spoolDir, item); } catch {} }
  await exit(exitCode);
}
try { previous = await scanSessions(sessions); }
catch (e) { await closeFailedStart(74, `Cannot scan Codex sessions: ${e.message}`); }
try { child = spawnCodex(process.argv.slice(2)); }
catch (e) { await closeFailedStart(127, e.message); }

let stoppedByMeter = false; let polling = false; let scanWarningShown = false; let forceKillTimer;
async function sample(finish = false) {
  if (polling) return; polling = true;
  try {
    try {
      const current = await scanSessions(sessions); absolute = addUsage(absolute, snapshotDelta(previous, current)); previous = current;
    } catch (e) {
      if (!scanWarningShown) { console.error(`Meter session scan warning: ${e.message}`); scanWarningShown = true; }
    }
    const item = { leaseId: lease.leaseId, usage: absolute, finish };
    try {
      const result = finish ? await meterApi.finish(config.serverUrl, config.meterToken, lease.leaseId, absolute) : await meterApi.update(config.serverUrl, config.meterToken, lease.leaseId, absolute);
      if (result.stop && !stoppedByMeter) {
        stoppedByMeter = true; console.error(`Meter requested stop: ${result.reason}`); child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
      }
    } catch (error) {
      if (isPermanentMeterError(error)) {
        if (!stoppedByMeter) {
          stoppedByMeter = true; console.error(`Meter protocol/authentication failure: ${error.data?.error || error.message}`); child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
        }
      } else {
        try { await spoolUpdate(spoolDir, item); } catch (e) { console.error(`Meter spool warning: ${e.message}`); }
      }
    }
  } finally { polling = false; }
}

let forwardedSignal = null;
const forwardSignal = (signal) => {
  forwardedSignal ??= signal;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    forceKillTimer ??= setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
  }
};
const onSigint = () => forwardSignal('SIGINT'); const onSigterm = () => forwardSignal('SIGTERM');
process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
const interval = setInterval(() => void sample(false).catch((e) => console.error(`Meter polling warning: ${e.message}`)), pollIntervalMs);
const outcome = await new Promise((resolve) => { child.once('error', (error) => resolve({ error })); child.once('exit', (code, signal) => resolve({ code, signal })); });
clearInterval(interval); if (forceKillTimer) clearTimeout(forceKillTimer);
process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm);
while (polling) await new Promise((r) => setTimeout(r, 10)); await sample(true);
if (outcome.error) { console.error(outcome.error.message); await exit(127); }
if (stoppedByMeter) await exit(75);
const signal = forwardedSignal || outcome.signal;
if (signal) await exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 128);
await exit(outcome.code ?? 1);
