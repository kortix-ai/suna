/**
 * base64url, implemented in place rather than over `atob`/`btoa`.
 *
 * `atob`/`btoa` are globals, and this module is `isomorphic-core`: it must run
 * where they may not exist (older Hermes/React Native, a locked-down worker)
 * without a `ReferenceError`. The tripwire walks imports and cannot see a bare
 * global (`AGENTS.md`), so the safe move is not to depend on one at all. Both
 * functions are ~15 lines and byte-identical to Node's `base64url`, which is
 * what `base64.test.ts` asserts.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Byte → char for encode; char → 6-bit value for decode (both variants). */
const DECODE_TABLE: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET[i] as string] = i;
  // Accept standard base64 as well as base64url.
  table['+'] = 62;
  table['/'] = 63;
  return table;
})();

/** Encode bytes as base64url — no padding, no `+`, no `/`. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Decode base64url (or standard base64) to a string, one byte per code unit.
 *
 * Throws on an invalid character instead of skipping it: a silent garbage
 * decode two layers up reads as "this JWT has no `exp`", i.e. "never expires".
 */
export function base64UrlDecode(value: string): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    if (char === '=') break;
    const bitValue = DECODE_TABLE[char];
    if (bitValue === undefined) {
      throw new Error(`invalid base64 character: ${JSON.stringify(char)}`);
    }
    buffer = (buffer << 6) | bitValue;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}
