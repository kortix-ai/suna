import { expect, test } from 'bun:test';
import { decodeBase64, encodeBase64 } from './base64';

// The doc routes carry Yjs updates as base64. The codec must run in a browser,
// React Native (Hermes) and Node without `Buffer`, `atob` or `btoa`.

const reference = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Run `fn` with the base64 globals removed, so a hidden use of one throws. */
function withoutGlobals<T>(fn: () => T): T {
  const scope = globalThis as Record<string, unknown>;
  const saved = { Buffer: scope.Buffer, atob: scope.atob, btoa: scope.btoa };
  delete scope.Buffer;
  delete scope.atob;
  delete scope.btoa;
  try {
    return fn();
  } finally {
    Object.assign(scope, saved);
  }
}

test('every length 0–64 and every byte value encodes as Buffer does, and decodes back', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const samples = [all, ...Array.from({ length: 65 }, (_, length) => Uint8Array.from({ length }, (_, i) => (i * 97 + length * 31) % 256))];
  for (const bytes of samples) {
    const text = withoutGlobals(() => encodeBase64(bytes));
    expect(text).toBe(reference(bytes));
    expect(withoutGlobals(() => decodeBase64(text))).toEqual(bytes);
  }
});

test('a 600 KiB update round-trips', () => {
  const bytes = Uint8Array.from({ length: 600 * 1024 }, (_, i) => (i * 7) % 256);
  const text = encodeBase64(bytes);
  expect(text).toBe(reference(bytes));
  expect(decodeBase64(text)).toEqual(bytes);
});

test('decoding accepts input without padding', () => {
  expect(decodeBase64('YQ')).toEqual(new Uint8Array([97]));
  expect(decodeBase64('YWI')).toEqual(new Uint8Array([97, 98]));
  expect(decodeBase64('')).toEqual(new Uint8Array([]));
});

test('decoding refuses a character outside the alphabet, a bad length and misplaced padding', () => {
  for (const bad of ['YQ=!', 'Y', 'YWJjZ', '=YWI', 'YW=I', 'YQ==YQ==', 'YWJj\n', '-_8=']) {
    expect(() => decodeBase64(bad)).toThrow(TypeError);
  }
});
