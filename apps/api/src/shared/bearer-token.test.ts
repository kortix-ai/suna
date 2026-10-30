import { describe, expect, test } from 'bun:test';
import { bearerToken } from './bearer-token';

describe('bearerToken', () => {
  test('returns the token after `Bearer `, as sent', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('Bearer  abc ')).toBe(' abc ');
    expect(bearerToken('Bearer ')).toBe('');
  });

  test('accepts any casing of the scheme (RFC 7235 §2.1)', () => {
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('BEARER abc')).toBe('abc');
    expect(bearerToken('BeArEr abc')).toBe('abc');
  });

  test('returns null for anything that is not a `Bearer ` value', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Token abc')).toBeNull();
    // `Bearer` + non-space separator is not the scheme.
    expect(bearerToken('Bearer\tabc')).toBeNull();
  });
});
