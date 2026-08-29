import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function safeAtom(value, maximum = 160) {
  return typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9_.:/+@-]+$/.test(value) ? value : null;
}
export function safeFilenameAtom(value, maximum = 80) {
  return typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9_.+@-]*$/.test(value) ? value : null;
}
export function childPath(directory, filename) {
  const root = path.resolve(directory); const target = path.resolve(root, filename);
  if (path.dirname(target) !== root) throw new Error('generated output path escapes its output directory');
  return target;
}
export function safeMetadataAtom(value, maximum = 100) {
  return typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9_.+-]+$/.test(value) ? value : null;
}
export function safeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))) return value;
  return null;
}
export async function loadProbeSecret(filename = path.resolve('phase0-output/.probe-secret')) {
  try { return await readFile(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const secret = crypto.randomBytes(32);
    try { await writeFile(filename, secret, { mode: 0o600, flag: 'wx' }); return secret; }
    catch (race) { if (race.code === 'EEXIST') return readFile(filename); throw race; }
  }
}
export function pseudonym(value, secret) {
  if (value == null) return null;
  return `hmac:${crypto.createHmac('sha256', secret).update(String(value)).digest('hex').slice(0, 24)}`;
}
export function idValue(value, { rawIds = false, secret } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!text || text.length > 500) return null;
  if (rawIds) return safeMetadataAtom(text, 160);
  return pseudonym(text, secret);
}
