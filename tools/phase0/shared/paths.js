import os from 'node:os';
import path from 'node:path';
import { opendir } from 'node:fs/promises';

export function codexHome(explicit = null) {
  return path.resolve(explicit || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}
export function sessionsRoot(explicit = null, home = null) {
  return explicit ? path.resolve(explicit) : path.join(codexHome(home), 'sessions');
}
export async function jsonlFiles(root) {
  const output = [];
  async function walk(directory) {
    let handle;
    try { handle = await opendir(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      for await (const entry of handle) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(full);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await walk(root);
  return output.sort();
}
