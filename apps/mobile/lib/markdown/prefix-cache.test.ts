import { describe, expect, test } from 'bun:test';
import { PrefixCache } from './prefix-cache';

describe('PrefixCache', () => {
  test('finds the longest saved prefix the text starts with', () => {
    const cache = new PrefixCache<number>();
    cache.set('a\n', 1);
    cache.set('b\n', 2);
    cache.set('b\nc\n', 3);
    expect(cache.find('b\nc\nd')).toEqual({ prefix: 'b\nc\n', value: 3 });
    expect(cache.find('a\nzzz')).toEqual({ prefix: 'a\n', value: 1 });
    expect(cache.find('c\n')).toBeUndefined();
  });

  test('a longer prefix replaces the entries it extends, and keeps the others', () => {
    const cache = new PrefixCache<number>();
    cache.set('a\n', 1);
    cache.set('x\n', 9);
    cache.set('a\nb\n', 2);
    expect(cache.find('a\n')).toBeUndefined();
    expect(cache.find('a\nb\nc')?.value).toBe(2);
    expect(cache.find('x\ny')?.value).toBe(9);
  });

  test('keeps the most recently used texts up to its size', () => {
    const cache = new PrefixCache<number>(2);
    cache.set('a\n', 1);
    cache.set('b\n', 2);
    cache.find('a\n!'); // a is now the most recent
    cache.set('c\n', 3); // drops b
    expect(cache.find('b\n!')).toBeUndefined();
    expect(cache.find('a\n!')?.value).toBe(1);
    expect(cache.find('c\n!')?.value).toBe(3);
  });
});
