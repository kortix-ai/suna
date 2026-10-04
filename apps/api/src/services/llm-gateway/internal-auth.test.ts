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
  test.each([
    ['no token configured', undefined, []],
    ['an empty list', '', []],
    ['a 23-char token', 'a'.repeat(23), [23]],
    ['a 24-char token', 'a'.repeat(24), []],
    ['a rotation list with one short entry', `${'a'.repeat(32)}, short`, [5]],
    ['a rotation list with two short entries', 'short1, short2', [6, 6]],
  ] as const)('%s', (_name, csv, shortLengths) => {
    expect(weakInternalTokenWarnings(csv)).toEqual(
      shortLengths.map((length) => expect.stringContaining(`only ${length} chars (want >= 24)`)),
    );
  });
});
