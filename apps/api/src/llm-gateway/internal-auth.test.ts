import { describe, expect, test } from 'bun:test';

import { matchesInternalToken, weakInternalTokenWarnings } from './internal-auth';

describe('matchesInternalToken', () => {
  test('accepts the configured token', () => {
    expect(matchesInternalToken('Bearer secret', 'secret')).toBe(true);
  });

  test('rejects a wrong token', () => {
    expect(matchesInternalToken('Bearer nope', 'secret')).toBe(false);
  });

  test('rejects when no token is configured', () => {
    expect(matchesInternalToken('Bearer secret', undefined)).toBe(false);
    expect(matchesInternalToken('Bearer secret', '')).toBe(false);
  });

  test('rejects a missing or malformed header', () => {
    expect(matchesInternalToken(undefined, 'secret')).toBe(false);
    expect(matchesInternalToken('secret', 'secret')).toBe(false);
    expect(matchesInternalToken('Bearer ', 'secret')).toBe(false);
  });

  test('supports a comma-separated rotation list', () => {
    expect(matchesInternalToken('Bearer new', 'old, new')).toBe(true);
    expect(matchesInternalToken('Bearer old', 'old, new')).toBe(true);
    expect(matchesInternalToken('Bearer other', 'old, new')).toBe(false);
  });

  test('is not fooled by length-prefix differences', () => {
    expect(matchesInternalToken('Bearer secre', 'secret')).toBe(false);
    expect(matchesInternalToken('Bearer secrets', 'secret')).toBe(false);
  });
});

describe('weakInternalTokenWarnings', () => {
  test('no warnings for unconfigured token', () => {
    expect(weakInternalTokenWarnings(undefined)).toEqual([]);
    expect(weakInternalTokenWarnings('')).toEqual([]);
  });

  test('warns on a short token', () => {
    expect(weakInternalTokenWarnings('short')).toHaveLength(1);
  });

  test('warns on a known-weak value regardless of case', () => {
    expect(weakInternalTokenWarnings('ChangeMe')).toHaveLength(1);
    expect(weakInternalTokenWarnings('secret')).toHaveLength(1);
  });

  test('no warning for a sufficiently long random-looking token', () => {
    expect(weakInternalTokenWarnings('a'.repeat(32))).toEqual([]);
  });

  test('checks every entry in a rotation list independently', () => {
    const warnings = weakInternalTokenWarnings(`${'a'.repeat(32)}, short`);
    expect(warnings).toHaveLength(1);
  });

  test('flags every weak entry when the whole list is weak', () => {
    expect(weakInternalTokenWarnings('short1, short2')).toHaveLength(2);
  });
});
