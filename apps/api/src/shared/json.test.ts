import { describe, expect, test } from 'bun:test';
import { isPlainObject, normalizeJsonObject } from './json';

describe('isPlainObject', () => {
  test('accepts JSON objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  test('rejects null, arrays, and scalars', () => {
    for (const value of [null, undefined, [], [{ a: 1 }], 'x', '', 0, 1, true, false]) {
      expect(isPlainObject(value)).toBe(false);
    }
  });
});

describe('normalizeJsonObject', () => {
  test('returns the same object for a JSON object', () => {
    const value = { a: 1 };
    expect(normalizeJsonObject(value)).toBe(value);
  });

  test('returns {} for every other value', () => {
    for (const value of [null, undefined, [], 'x', 0, true]) {
      expect(normalizeJsonObject(value)).toEqual({});
    }
  });
});
