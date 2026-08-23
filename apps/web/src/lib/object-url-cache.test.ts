import { beforeEach, describe, expect, test } from 'bun:test';
import { ObjectUrlCache } from './object-url-cache';

const revoked: string[] = [];
beforeEach(() => {
  revoked.length = 0;
  // bun's environment has no URL.revokeObjectURL; the cache must call it when
  // it exists and survive when it does not.
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => {
    revoked.push(u);
  };
});

describe('ObjectUrlCache', () => {
  test('serves a cached url without refetching — the property the old cache protected', () => {
    const cache = new ObjectUrlCache(4);
    cache.set('a', 'blob:a');
    expect(cache.get('a')).toBe('blob:a');
    expect(revoked).toEqual([]);
  });

  test('evicts the least recently USED and revokes it', () => {
    const cache = new ObjectUrlCache(2);
    cache.set('a', 'blob:a');
    cache.set('b', 'blob:b');
    // Touching 'a' makes 'b' the oldest, even though 'a' was inserted first.
    expect(cache.get('a')).toBe('blob:a');
    cache.set('c', 'blob:c');

    expect(revoked).toEqual(['blob:b']);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.size).toBe(2);
  });

  test('replacing a key revokes the url it replaces', () => {
    const cache = new ObjectUrlCache(4);
    cache.set('a', 'blob:one');
    cache.set('a', 'blob:two');
    expect(revoked).toEqual(['blob:one']);
    expect(cache.get('a')).toBe('blob:two');
  });

  test('re-setting the identical url revokes nothing', () => {
    const cache = new ObjectUrlCache(4);
    cache.set('a', 'blob:same');
    cache.set('a', 'blob:same');
    expect(revoked).toEqual([]);
  });

  test('clear releases everything it holds', () => {
    const cache = new ObjectUrlCache(4);
    cache.set('a', 'blob:a');
    cache.set('b', 'blob:b');
    cache.clear();
    expect(revoked.sort()).toEqual(['blob:a', 'blob:b']);
    expect(cache.size).toBe(0);
  });

  test('a revoke that throws never breaks the cache', () => {
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {
      throw new Error('no document');
    };
    const cache = new ObjectUrlCache(1);
    cache.set('a', 'blob:a');
    expect(() => cache.set('b', 'blob:b')).not.toThrow();
    expect(cache.has('b')).toBe(true);
  });
});
