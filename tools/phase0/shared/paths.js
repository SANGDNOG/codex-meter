import os from 'node:os';
import path from 'node:path';
import { opendir } from 'node:fs/promises';

export function codexHome(explicit = null) {
  return path.resolve(explicit || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}
export function sessionsRoot(explicit = null, home = null) {
  return explicit ? path.resolve(explicit) : path.join(codexHome(home), 'sessions');
}

async function rolloutFiles(root, archived) {
  const output = [];
  async function walk(directory) {
    let handle;
    try { handle = await opendir(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      for await (const entry of handle) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst'))) {
          output.push({ path: full, archived, compressed: entry.name.endsWith('.zst') });
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await walk(root);
  return output;
}

/**
 * Discover rollout representations. With no explicit root both current Codex roots are scanned.
 * A .jsonl sibling wins over .jsonl.zst; compressed-only files are reported but never decoded.
 */
export async function discoverRollouts({ root = null, home = null } = {}) {
  const roots = root
    ? [{ path: path.resolve(root), archived: path.basename(path.resolve(root)) === 'archived_sessions' }]
    : [
        { path: path.join(codexHome(home), 'sessions'), archived: false },
        { path: path.join(codexHome(home), 'archived_sessions'), archived: true }
      ];
  const candidates = (await Promise.all(roots.map((item) => rolloutFiles(item.path, item.archived)))).flat();
  // Canonical representation identity is the filename without the compression suffix. This also
  // prevents a move that temporarily exists under both active and archive roots being counted twice.
  const selected = new Map();
  for (const item of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    const key = path.basename(item.path).replace(/\.zst$/, '');
    const previous = selected.get(key);
    if (!previous || (previous.compressed && !item.compressed)) selected.set(key, item);
  }
  const files = [...selected.values()].filter((item) => !item.compressed).sort((a, b) => a.path.localeCompare(b.path));
  const compressed = candidates.filter((item) => item.compressed);
  const compressedOnly = [...selected.values()].filter((item) => item.compressed);
  return {
    files,
    compressedRolloutsDetected: compressed.length > 0,
    compressedRolloutCount: compressed.length,
    compressedOnlyRolloutCount: compressedOnly.length,
    archivedRolloutsDetected: candidates.some((item) => item.archived),
    archivedRolloutCount: candidates.filter((item) => item.archived).length,
    scanCompleteness: compressedOnly.length ? 'incomplete_compressed' : 'complete'
  };
}

// Backwards-compatible explicit-root helper used by older callers/tests.
export async function jsonlFiles(root) {
  return (await discoverRollouts({ root })).files.map((item) => item.path);
}
