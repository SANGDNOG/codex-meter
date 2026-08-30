import { readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['bin', 'lib', 'scripts', 'test', 'tools/phase0', 'v2'];
const files = [];
async function walk(item) {
  const info = await stat(item);
  if (info.isDirectory()) for (const child of (await readdir(item)).sort()) await walk(path.join(item, child));
  else if (item.endsWith('.js')) files.push(item);
}
for (const root of roots) await walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`syntax ok: ${files.length} JavaScript files`);