import { expect, test } from 'bun:test';
import { BoundedMap } from './bounded-map';

test('evicts the oldest key past the cap and keeps a refreshed key', () => {
  const map = new BoundedMap<string, number>(2);
  map.set('a', 1);
  map.set('b', 2);
  map.set('a', 3); // refresh: now the newest
  map.set('c', 4);
  expect([...map.keys()]).toEqual(['a', 'c']);
  expect(map.size).toBe(2);
});
