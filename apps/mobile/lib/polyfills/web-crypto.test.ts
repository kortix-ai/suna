import { afterAll, beforeAll, expect, mock, test } from 'bun:test';

// Hermes has no `crypto` global. Simulate it, then load the polyfill.
const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const fill = (bytes: Uint8Array) => bytes.fill(7);

beforeAll(async () => {
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  mock.module('expo-crypto', () => ({ getRandomValues: fill, randomUUID: () => 'uuid-from-expo' }));
  await import('./web-crypto');
});

afterAll(() => {
  if (original) Object.defineProperty(globalThis, 'crypto', original);
});

test('installs getRandomValues and randomUUID from expo-crypto when the engine has no crypto', () => {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  expect(Array.from(bytes)).toEqual([7, 7, 7, 7]);
  expect(String(globalThis.crypto.randomUUID())).toBe('uuid-from-expo');
});
