import os from 'node:os';
import path from 'node:path';
import { opendir, stat } from 'node:fs/promises';

const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

export function codexHome(explicit = null) {
  return path.resolve(explicit || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

async function walk(root, archived, output) {
  let directory;
  try { directory = await opendir(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    for await (const entry of directory) {
      const filename = path.join(root, entry.name);
      if (entry.isDirectory()) await walk(filename, archived, output);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) {
        let info;
        try { info = await stat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const uuid = entry.name.match(UUID_SUFFIX)?.[1]?.toLowerCase() ?? null;
        const representation = entry.name.replace(/\.zst$/, '');
        output.push({ path: filename, archived, compressed: entry.name.endsWith('.zst'), size: info.size,
          physicalIdentity: uuid ? `rollout:${uuid}` : `inode:${info.dev}:${info.ino}`, representation });
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Active and archive discovery. One physical rollout is returned once; readable plain wins over zst. */
export async function discoverRollouts({ home = null, roots = null } = {}) {
  const candidates = [];
  const scanRoots = roots ?? [
    { path: path.join(codexHome(home), 'sessions'), archived: false },
    { path: path.join(codexHome(home), 'archived_sessions'), archived: true }
  ];
  await Promise.all(scanRoots.map((root) => walk(path.resolve(root.path), Boolean(root.archived), candidates)));
  const selected = new Map();
  for (const item of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    // UUID is stable across archive moves. Inode is stable for noncanonical test/variant names.
    const key = item.physicalIdentity;
    const prior = selected.get(key);
    if (!prior || (prior.compressed && !item.compressed)) selected.set(key, item);
  }
  return {
    files: [...selected.values()].filter((item) => !item.compressed).sort((a, b) => a.physicalIdentity.localeCompare(b.physicalIdentity)),
    compressedFiles: [...selected.values()].filter((item) => item.compressed).sort((a, b) => a.physicalIdentity.localeCompare(b.physicalIdentity)),
    compressedOnly: [...selected.values()].filter((item) => item.compressed).length,
    compressedDetected: candidates.some((item) => item.compressed)
  };
}
