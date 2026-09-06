import { createHash } from 'node:crypto';

export const existingRootKey = bindingKey => `existing_root_identity:${createHash('sha256').update(bindingKey).digest('hex')}`;
export const profileRootKey = profile => `${profile.accountId}:${profile.selectionKey}`;

export function rootIdentityFromStat(home, info) {
  if (typeof info.dev !== 'bigint' || typeof info.ino !== 'bigint' || typeof info.birthtimeNs !== 'bigint') return null;
  // Decimal strings retain all BigInt precision and also suit local SQLite JSON.
  const value = {home,dev:String(info.dev),ino:String(info.ino),birthtimeNs:String(info.birthtimeNs)};
  return validRootIdentity(value) ? value : null;
}

// dev/ino can be recycled after deletion, including across Agent restarts.
// A usable creation identity is mandatory; ctime is mutable and is not a
// substitute. Older incomplete records require normal explicit reselection.
export function validRootIdentity(value) {
  return value && typeof value.home === 'string' && typeof value.dev === 'string' && /^\d+$/.test(value.dev) &&
    typeof value.ino === 'string' && /^[1-9]\d*$/.test(value.ino) &&
    typeof value.birthtimeNs === 'string' && /^[1-9]\d*$/.test(value.birthtimeNs);
}
export function rootIdentityMatches(expected, home, info) {
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return validRootIdentity(expected) && comparable(expected.home) === comparable(home) &&
    expected.dev === String(info.dev) && expected.ino === String(info.ino) && expected.birthtimeNs === String(info.birthtimeNs);
}
export function readExistingRoot(database, bindingKey, home = null) {
  if (!database || !bindingKey) return null;
  try {
    const value = JSON.parse(database.prepare('SELECT value FROM agent_state WHERE key=?').get(existingRootKey(bindingKey))?.value ?? 'null');
    return validRootIdentity(value) && (home === null || value.home === home) ? value : null;
  } catch { return null; }
}
