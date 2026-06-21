import { describe, test, expect } from 'bun:test';
import { safeJsonParse, safeJsonStringify } from './json';

describe('safeJsonParse', () => {
  test('returns default value for null input', () => {
    expect(safeJsonParse(null, 'fallback')).toBe('fallback');
  });

  test('returns default value for undefined input', () => {
    expect(safeJsonParse(undefined, 'fallback')).toBe('fallback');
  });

  test('returns pre-parsed objects as-is', () => {
    const obj = { a: 1, b: [2, 3] };
    expect(safeJsonParse(obj, {})).toBe(obj);
  });

  test('returns pre-parsed arrays as-is', () => {
    const arr = [1, 2, 3];
    expect(safeJsonParse(arr as any, [] as unknown[])).toBe(arr);
  });

  test('parses a valid JSON object string', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  test('parses a valid JSON array string', () => {
    expect(safeJsonParse('[1,2,3]', [] as unknown[])).toEqual([1, 2, 3]);
  });

  test('parses a double-escaped JSON object string', () => {
    const doubleEscaped = JSON.stringify(JSON.stringify({ a: 1 }));
    expect(safeJsonParse(doubleEscaped, {})).toEqual({ a: 1 });
  });

  test('returns inner string when double-unescape fails', () => {
    const value = JSON.stringify('{not valid json');
    expect(safeJsonParse(value, 'fallback')).toBe('{not valid json');
  });

  test('parses the literal "true" into boolean true', () => {
    expect(safeJsonParse<unknown>('true', null)).toBe(true);
  });

  test('parses the literal "false" into boolean false', () => {
    expect(safeJsonParse<unknown>('false', null)).toBe(false);
  });

  test('parses the literal "null" into null', () => {
    expect(safeJsonParse<unknown>('null', 'fallback')).toBe(null);
  });

  test('parses a numeric string into a number', () => {
    expect(safeJsonParse('42', 0)).toBe(42);
    expect(safeJsonParse('3.14', 0)).toBe(3.14);
  });

  test('returns plain non-json strings as-is', () => {
    expect(safeJsonParse('hello world', 'fallback')).toBe('hello world');
  });

  test('returns default value for malformed json object string', () => {
    expect(safeJsonParse('{broken', 'fallback')).toBe('fallback');
  });

  test('returns default value for malformed json array string', () => {
    expect(safeJsonParse('[broken', 'fallback')).toBe('fallback');
  });

  test('does not coerce whitespace-only strings into numbers', () => {
    expect(safeJsonParse('   ', 'fallback')).toBe('   ');
  });

  test('returns default for non-string non-object primitives', () => {
    expect(safeJsonParse(123 as any, 'fallback')).toBe('fallback');
  });
});

describe('safeJsonStringify', () => {
  test('stringifies a plain object', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  test('stringifies an array', () => {
    expect(safeJsonStringify([1, 2, 3])).toBe('[1,2,3]');
  });

  test('stringifies primitives', () => {
    expect(safeJsonStringify(42)).toBe('42');
    expect(safeJsonStringify('hi')).toBe('"hi"');
  });

  test('returns the default value when stringify throws on circular references', () => {
    const circular: any = {};
    circular.self = circular;
    expect(safeJsonStringify(circular)).toBe('{}');
  });

  test('returns a custom default value on failure', () => {
    const circular: any = {};
    circular.self = circular;
    expect(safeJsonStringify(circular, 'ERR')).toBe('ERR');
  });
});
