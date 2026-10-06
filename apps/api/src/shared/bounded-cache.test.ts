import { expect, test } from 'bun:test';
import { setBounded } from './bounded-cache';

test('a map never grows past its cap and keeps the newest entries', () => {
  const map = new Map<string, number>();
  for (let i = 0; i < 1000; i++) setBounded(map, `k${i}`, i, 100);
  expect(map.size).toBeLessThanOrEqual(100);
  expect(map.has('k999')).toBe(true);
  expect(map.has('k0')).toBe(false);
});

test('overwriting an existing key does not evict', () => {
  const map = new Map([['a', 1], ['b', 2]]);
  setBounded(map, 'a', 3, 2);
  expect([...map]).toEqual([['a', 3], ['b', 2]]);
});
