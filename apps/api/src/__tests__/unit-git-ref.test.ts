import { describe, expect, test } from 'bun:test';
import { validateRef, validateSha } from '../projects/git-ref';

describe('validateRef', () => {
  test('accepts ordinary branch names, tags, HEAD and SHAs', () => {
    for (const ref of ['main', 'HEAD', 'feature/new-thing', 'release-1.2', 'v1.2.3', 'a1b2c3d', 'refs/heads/main', 'session_abc.123']) {
      expect(validateRef(ref)).toBe(ref);
    }
  });

  test('rejects option-injection refs (leading dash)', () => {
    // git grep --open-files-in-pager=<cmd> and git archive --output=<path>
    // would be RCE / arbitrary-write if a ref starting with "-" reached git.
    expect(() => validateRef('--open-files-in-pager=touch /tmp/pwned')).toThrow();
    expect(() => validateRef('--output=/etc/passwd')).toThrow();
    expect(() => validateRef('-x')).toThrow();
  });

  test('rejects refs with unsafe characters or range/rev syntax', () => {
    for (const bad of ['a b', 'a..b', 'main;rm -rf', 'main$(id)', 'HEAD~1', 'HEAD^', 'a@{0}', 'a:b', 'a\\b']) {
      expect(() => validateRef(bad)).toThrow();
    }
  });

  test('rejects empty ref', () => {
    expect(() => validateRef('')).toThrow();
  });
});

describe('validateSha', () => {
  test('accepts hex SHAs of 4-64 chars', () => {
    expect(validateSha('a1b2')).toBe('a1b2');
    expect(validateSha('0123456789abcdef0123456789abcdef01234567')).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
  });

  test('rejects non-hex / too-short / injection', () => {
    for (const bad of ['', 'xyz', 'abc', '--x', 'a1b2; rm']) {
      expect(() => validateSha(bad)).toThrow();
    }
  });
});
