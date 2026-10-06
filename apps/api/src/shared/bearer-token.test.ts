import { describe, expect, test } from 'bun:test';
import { bearerToken } from './bearer-token';

describe('bearerToken', () => {
  test('returns the token after `Bearer `, as sent', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('Bearer  abc ')).toBe(' abc ');
    expect(bearerToken('Bearer ')).toBe('');
  });

  test('returns null for anything that is not a `Bearer ` value', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('bearer abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Token abc')).toBeNull();
  });
});
