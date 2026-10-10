import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from './random-uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Shadow the prototype method on the instance; Bun's prototype property is not configurable.
const stubRandomUUID = (value: unknown) =>
  Object.defineProperty(crypto, 'randomUUID', { value, configurable: true });

afterEach(() => {
  delete (crypto as { randomUUID?: unknown }).randomUUID;
});

test('returns a v4 UUID on a page without crypto.randomUUID (plain http on a LAN address)', () => {
  // Browsers expose randomUUID only in secure contexts (https, localhost).
  stubRandomUUID(undefined);
  const a = randomUUID();
  const b = randomUUID();
  expect(a).toMatch(V4);
  expect(b).toMatch(V4);
  expect(a).not.toBe(b);
});

test('uses crypto.randomUUID when the page has it', () => {
  stubRandomUUID(() => '00000000-0000-4000-8000-000000000000');
  expect(randomUUID()).toBe('00000000-0000-4000-8000-000000000000');
});
