import { describe, expect, test } from 'bun:test';
import {
  MAX_EMAIL_SENDER_REGEX_LENGTH,
  compileEmailSenderRegex,
  matchesEmailSenderRegex,
} from './sender-policy-regex';

describe('email sender regex', () => {
  test('preserves useful case-insensitive and unanchored matching', () => {
    for (const pattern of [
      '.*@example\\.com$',
      '^(alice|bob)@example\\.com$',
      '^vendor-[0-9]{1,4}@example\\.org$',
    ]) {
      expect(() => compileEmailSenderRegex(pattern)).not.toThrow();
    }

    expect(matchesEmailSenderRegex('advisor@example\\.com', 'Senior.Advisor@EXAMPLE.COM')).toBe(
      true,
    );
    expect(matchesEmailSenderRegex('^alice@example\\.com$', 'malice@example.com')).toBe(false);
  });

  test('rejects unsupported backtracking-only syntax and oversized patterns', () => {
    expect(() => compileEmailSenderRegex('^(?=alice)alice@example\\.com$')).toThrow(
      'unsupported by the safe RE2 engine',
    );
    expect(() => compileEmailSenderRegex('^(a)\\1@example\\.com$')).toThrow(
      'unsupported by the safe RE2 engine',
    );
    expect(() => compileEmailSenderRegex('a'.repeat(MAX_EMAIL_SENDER_REGEX_LENGTH + 1))).toThrow(
      `at most ${MAX_EMAIL_SENDER_REGEX_LENGTH} characters`,
    );
  });

  test('executes counted repetition and overlapping alternation in bounded time', () => {
    const adversarialInput = `${'a'.repeat(50_000)}!@example.com`;
    const patterns = ['^(a{1,3})+@example\\.com$', '^(a|aa)+@example\\.com$'];
    const startedAt = performance.now();

    for (const pattern of patterns) {
      expect(() => compileEmailSenderRegex(pattern)).not.toThrow();
      expect(matchesEmailSenderRegex(pattern, adversarialInput)).toBe(false);
    }

    // Native JavaScript RegExp can take exponentially long on these failures.
    // RE2JS is linear; this generous ceiling catches accidental fallback to
    // the backtracking engine without making ordinary CI scheduling flaky.
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('fails closed for an unsupported legacy stored pattern', () => {
    expect(matchesEmailSenderRegex('^(?=alice)alice@example\\.com$', 'alice@example.com')).toBe(
      false,
    );
  });
});
