import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}
export function printJson(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
export function option(args, name, fallback = null) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
}
export function has(args, name) { return args.includes(name); }
export function assertNoUnknown(args, valued = [], flags = []) {
  const known = new Set([...valued, ...flags]);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`unknown argument: ${args[i]}`);
    if (valued.includes(args[i])) {
      if (++i >= args.length) throw new Error(`missing value for ${args[i - 1]}`);
    }
  }
}
