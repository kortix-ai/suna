import { describe, expect, test } from 'bun:test';

import {
  IMAGE_AUTO_LOAD_LIMIT_BYTES,
  createProbeCache,
  decideImageLoad,
  formatMegabytes,
  parseContentLength,
} from './image-load';

describe('IMAGE_AUTO_LOAD_LIMIT_BYTES', () => {
  test('is 8 MB', () => {
    expect(IMAGE_AUTO_LOAD_LIMIT_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('decideImageLoad', () => {
  const limitBytes = IMAGE_AUTO_LOAD_LIMIT_BYTES;

  test('loads when the length is unknown', () => {
    expect(decideImageLoad({ contentLength: null, limitBytes })).toBe('load');
  });

  test('loads at or below the limit', () => {
    expect(decideImageLoad({ contentLength: 0, limitBytes })).toBe('load');
    expect(decideImageLoad({ contentLength: limitBytes, limitBytes })).toBe('load');
  });

  test('asks for a tap above the limit', () => {
    expect(decideImageLoad({ contentLength: limitBytes + 1, limitBytes })).toBe('tap-to-load');
  });
});

describe('parseContentLength', () => {
  test('parses a non-negative integer header', () => {
    expect(parseContentLength('1048576')).toBe(1048576);
    expect(parseContentLength(' 42 ')).toBe(42);
  });

  test('returns null for missing or invalid values', () => {
    expect(parseContentLength(null)).toBeNull();
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('abc')).toBeNull();
    expect(parseContentLength('-5')).toBeNull();
    expect(parseContentLength('1.5')).toBeNull();
  });
});

describe('formatMegabytes', () => {
  test('formats with one decimal below 10 MB and whole numbers above', () => {
    expect(formatMegabytes(9 * 1024 * 1024)).toBe('9.0 MB');
    expect(formatMegabytes(8.5 * 1024 * 1024)).toBe('8.5 MB');
    expect(formatMegabytes(25 * 1024 * 1024)).toBe('25 MB');
  });
});

describe('createProbeCache', () => {
  test('stores known and unknown lengths', () => {
    const cache = createProbeCache(3);
    cache.set('a', 10);
    cache.set('b', null);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('a')).toBe(10);
    expect(cache.has('b')).toBe(true);
    expect(cache.get('b')).toBeNull();
    expect(cache.has('c')).toBe(false);
  });

  test('evicts the least recently used entry above the limit', () => {
    const cache = createProbeCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.size()).toBe(2);
  });
});
