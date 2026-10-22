import { describe, expect, test } from 'bun:test';
import { validateCommand } from './command-validator';

describe('validateCommand blocked commands', () => {
  test('a blocked name blocks its absolute and relative path spellings', () => {
    for (const spelling of ['rm', '/bin/rm', '/usr/bin/rm', './rm']) {
      expect(() => validateCommand(spelling, [], ['rm'])).toThrow(/is blocked/);
    }
  });
  test('an unrelated command with the blocked name inside a directory still runs', () => {
    expect(validateCommand('/opt/rm-tools/ls', [], ['rm'])).toBe('/opt/rm-tools/ls');
  });
  test('an allowlist stays an exact match', () => {
    expect(() => validateCommand('/usr/bin/git', ['git'], [])).toThrow(/not in the allowed/);
    expect(validateCommand('git', ['git'], [])).toBe('git');
  });
});
