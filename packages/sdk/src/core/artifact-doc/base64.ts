/**
 * Standard base64 (RFC 4648 §4) for the doc routes, which carry Yjs updates as
 * base64 strings. Internal: not in the public barrel.
 *
 * Pure JavaScript on purpose. `Buffer` exists only in Node and Bun, and
 * `atob`/`btoa` are absent on older React Native (Hermes) and take binary
 * strings, so neither runs on every host the SDK supports.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

/** Encode bytes as padded base64. */
export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = '';
  const whole = bytes.length - (bytes.length % 3);
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
    if (chunk.length >= 8_192) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  const rest = bytes.length - whole;
  if (rest === 1) {
    const n = bytes[whole]! << 16;
    chunk += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[whole]! << 16) | (bytes[whole + 1]! << 8);
    chunk += `${ALPHABET[n >> 18]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`;
  }
  chunks.push(chunk);
  return chunks.join('');
}

/**
 * Decode base64, with or without padding. Throws `TypeError` for a character
 * outside the standard alphabet (whitespace and the URL-safe `-`/`_` included),
 * padding that is not at the end, or a length no encoder produces.
 */
export function decodeBase64(text: string): Uint8Array {
  let end = text.length;
  if (end % 4 === 0 && text.endsWith('==')) end -= 2;
  else if (end % 4 === 0 && text.endsWith('=')) end -= 1;
  if (end % 4 === 1) throw new TypeError('Invalid base64: impossible length');
  const bytes = new Uint8Array(Math.floor((end * 3) / 4));
  let out = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? VALUES[code]! : -1;
    if (value < 0) throw new TypeError(`Invalid base64: unexpected character at ${i}`);
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}
