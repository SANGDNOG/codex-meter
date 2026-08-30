export const INT64_MIN = -(1n << 63n);
export const INT64_MAX = (1n << 63n) - 1n;

const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;

function parse(value, signed) {
  if (typeof value !== 'string' || !(signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(value)) {
    throw new TypeError(`expected a canonical ${signed ? 'signed ' : ''}decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > INT64_MAX || parsed < (signed ? INT64_MIN : 0n)) {
    throw new RangeError('decimal string is outside the signed 64-bit SQLite range');
  }
  return parsed;
}

export function parseUnsignedInt64(value) {
  return parse(value, false);
}

export function parseSignedInt64(value) {
  return parse(value, true);
}

export function toDecimalString(value, { signed = true } = {}) {
  if (typeof value !== 'bigint') throw new TypeError('expected bigint');
  if (value > INT64_MAX || value < (signed ? INT64_MIN : 0n)) throw new RangeError('value is outside range');
  return value.toString();
}

export function addDecimalStrings(left, right, { signed = false } = {}) {
  const parser = signed ? parseSignedInt64 : parseUnsignedInt64;
  return toDecimalString(parser(left) + parser(right), { signed });
}
