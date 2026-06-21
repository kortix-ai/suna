const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function getCrypto(): Crypto {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random generation is unavailable');
  }
  return globalThis.crypto;
}

export function randomBase62(length: number): string {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error('Random length must be a positive integer');
  }

  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);

  let value = '';
  for (const byte of bytes) {
    value += BASE62[byte % BASE62.length];
  }
  return value;
}

export function randomHex(byteLength: number): string {
  if (!Number.isInteger(byteLength) || byteLength < 1) {
    throw new Error('Random byte length must be a positive integer');
  }

  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
