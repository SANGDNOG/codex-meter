import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path'; import crypto from 'node:crypto'; import os from 'node:os';

async function request(baseUrl, token, route, method = 'GET', value) {
  const response = await fetch(new URL(route, baseUrl), { method, headers: { authorization: `Bearer ${token}`, ...(value ? { 'content-type': 'application/json' } : {}) }, body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `HTTP ${response.status}`); error.status = response.status; error.data = data; throw error; }
  return data;
}
export const meterApi = {
  start: (url, token) => request(url, token, '/v1/leases', 'POST'),
  update: (url, token, id, usage) => request(url, token, `/v1/leases/${encodeURIComponent(id)}`, 'PUT', { usage }),
  finish: (url, token, id, usage) => request(url, token, `/v1/leases/${encodeURIComponent(id)}/finish`, 'POST', { usage })
};
export function isPermanentMeterError(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
}

export async function spoolUpdate(spoolDir, item) {
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  const target = path.join(spoolDir, `${item.leaseId}.json`); const temp = `${target}.${crypto.randomUUID()}.tmp`;
  // Contains only lease ID, absolute numeric usage, and finish flag—never token or session content.
  await writeFile(temp, `${JSON.stringify(item)}\n`, { mode: 0o600 }); await rename(temp, target);
}
export async function replaySpool(spoolDir, send) {
  let names; try { names = (await readdir(spoolDir)).filter((x) => x.endsWith('.json')).sort(); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  let replayed = 0;
  for (const name of names) {
    const filename = path.join(spoolDir, name);
    try { const item = JSON.parse(await readFile(filename, 'utf8')); await send(item); await unlink(filename); replayed++; }
    catch { /* retain for the next invocation */ }
  }
  return replayed;
}

/** Prevent two wrappers from scanning the same CODEX_HOME concurrently. */
export async function acquireClientLock(home, { pid = process.pid, hostname = os.hostname() } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const filename = path.join(home, 'client.lock');
  const nonce = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid, hostname, nonce, createdAt: Date.now() })}\n`); await handle.close();
      return async () => {
        try { const owner = JSON.parse(await readFile(filename, 'utf8')); if (owner.nonce === nonce) await unlink(filename); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(await readFile(filename, 'utf8')); } catch { throw new Error(`client lock exists and is unreadable: ${filename}`); }
      let alive = owner.hostname !== hostname;
      if (!alive && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); alive = true; } catch (probe) { if (probe.code !== 'ESRCH') alive = true; }
      }
      if (alive) throw new Error(`another codex-meter wrapper is already active for this client home (pid ${owner.pid})`);
      await unlink(filename).catch((unlinkError) => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
    }
  }
  throw new Error(`could not acquire client lock: ${filename}`);
}
