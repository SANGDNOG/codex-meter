import { lstat, opendir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rootIdentityFromStat, rootIdentityMatches } from './existing-root.js';

export function defaultEnvironmentSearch(home = os.homedir()) {
  return { roots: [path.join(home, '.codex-home'), path.join(home, '.codex-profiles')], direct: [path.join(home, '.codex')] };
}

export function localDirectoryInput(input) {
  if (typeof input !== 'string' || !input.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(input)) throw new Error('Enter an existing directory path.');
  return path.resolve(input === '~' ? os.homedir() : input.startsWith(`~${path.sep}`) ? path.join(os.homedir(), input.slice(2)) : input);
}

export function sameLocalDirectoryPath(left, right, platform = process.platform) {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Called only by an explicit local UI action. Never inspect files inside a
// candidate, follow directory links, recurse, or persist/report this inventory.
export async function findEnvironmentCandidates({ roots, direct = [], maxEntries = 512, maxCandidates = 100 } = {}) {
  if (!Array.isArray(roots) || !Array.isArray(direct) || roots.length + direct.length > 16) throw new Error('Choose at most 16 local search locations.');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096 || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) throw new Error('Invalid local search bounds.');
  const candidates = [], identities = new Map(), seen = new Set();
  let visited = 0, truncated = false, unavailable = 0;
  const directory = async input => {
    const resolved = localDirectoryInput(input), info = await lstat(resolved, {bigint:true});
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const canonical = await realpath(resolved);
    // Do not follow symlinks in ancestors either. Linked Homes remain available
    // through the explicit manual attachment flow.
    if (!sameLocalDirectoryPath(canonical, resolved)) return null;
    const identity = rootIdentityFromStat(canonical, info);
    return identity ? { path: canonical, ...identity } : null;
  };
  const add = async input => {
    const identity = await directory(input);
    if (!identity) return;
    const canonical = identity.path;
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) return;
    if (candidates.length === maxCandidates) { truncated = true; return; }
    seen.add(key); candidates.push(canonical); identities.set(canonical, identity);
  };
  for (const input of direct) {
    try { await add(input); } catch { unavailable++; }
  }
  for (const input of roots) {
    if (truncated) break;
    try {
      const root = await directory(input);
      if (!root) { unavailable++; continue; }
      const entries = await opendir(root.path, { bufferSize: 1 });
      for await (const entry of entries) {
        if (++visited > maxEntries) { truncated = true; break; }
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try { await add(path.join(root.path, entry.name)); } catch { unavailable++; }
        if (truncated) break;
      }
    } catch { unavailable++; }
  }
  return { candidates: candidates.sort(), identities, truncated, unavailable };
}

export async function assertCandidateUnchanged(expected) {
  try {
    const info = await lstat(expected.path, {bigint:true});
    const canonical = await realpath(expected.path);
    if (info.isDirectory() && !info.isSymbolicLink() && sameLocalDirectoryPath(canonical, expected.path) && rootIdentityMatches(expected, canonical, info)) return;
  } catch { /* Missing or inaccessible selections also need a new explicit choice. */ }
  const error = new Error('The listed environment changed. Search again and select its current location.');
  error.code = 'candidate_changed';
  throw error;
}
