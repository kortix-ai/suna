import { describe, expect, test } from 'bun:test';

import { matchesInternalToken, weakInternalTokenWarnings } from './internal-auth';

const SECRET = 'secret-'.padEnd(32, 's');
const NOPE = 'nope-'.padEnd(32, 'n');
const NEW = 'new-'.padEnd(32, 'w');
const OLD = 'old-'.padEnd(32, 'o');
const OTHER = 'other-'.padEnd(32, 'x');

describe('matchesInternalToken', () => {
  test('refuses a token shorter than 24 chars even when it is presented exactly', () => {
    expect(matchesInternalToken(`Bearer ${'a'.repeat(23)}`, 'a'.repeat(23))).toBe(false);
    expect(matchesInternalToken(`Bearer ${'a'.repeat(24)}`, 'a'.repeat(24))).toBe(true);
  });

  test('accepts the configured token', () => {
    expect(matchesInternalToken(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  test('rejects a wrong token', () => {
    expect(matchesInternalToken(`Bearer ${NOPE}`, SECRET)).toBe(false);
  });

  test('rejects when no token is configured', () => {
    expect(matchesInternalToken(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(matchesInternalToken(`Bearer ${SECRET}`, '')).toBe(false);
  });

  test('rejects a missing or malformed header', () => {
    expect(matchesInternalToken(undefined, SECRET)).toBe(false);
    expect(matchesInternalToken(SECRET, SECRET)).toBe(false);
    expect(matchesInternalToken('Bearer ', SECRET)).toBe(false);
  });

  test('supports a comma-separated rotation list', () => {
    expect(matchesInternalToken(`Bearer ${NEW}`, `${OLD}, ${NEW}`)).toBe(true);
    expect(matchesInternalToken(`Bearer ${OLD}`, `${OLD}, ${NEW}`)).toBe(true);
    expect(matchesInternalToken(`Bearer ${OTHER}`, `${OLD}, ${NEW}`)).toBe(false);
  });

  test('is not fooled by length-prefix differences', () => {
    expect(matchesInternalToken(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(matchesInternalToken(`Bearer ${SECRET}s`, SECRET)).toBe(false);
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
