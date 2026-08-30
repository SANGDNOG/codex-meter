import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, length: 32 });

export function secret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function salt() {
  return randomBytes(16).toString('base64url');
}

function equalBuffers(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashSecret(value, secretSalt) {
  return createHash('sha256').update(secretSalt).update('\0').update(value).digest('base64url');
}

export function verifySecret(value, secretSalt, expected) {
  if (typeof value !== 'string' || typeof secretSalt !== 'string' || typeof expected !== 'string') return false;
  return equalBuffers(Buffer.from(hashSecret(value, secretSalt)), Buffer.from(expected));
}

export function hashPassword(password, passwordSalt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('password must be 12 to 1024 characters');
  return scryptSync(password, Buffer.from(passwordSalt, 'base64url'), SCRYPT.length, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024
  }).toString('base64url');
}

export function verifyPassword(password, passwordSalt, expected) {
  try {
    const actual = hashPassword(password, passwordSalt);
    return equalBuffers(Buffer.from(actual), Buffer.from(expected));
  } catch {
    // Perform comparable work even for malformed input before rejecting.
    try { hashPassword('invalid-password-padding', passwordSalt); } catch {}
    return false;
  }
}
