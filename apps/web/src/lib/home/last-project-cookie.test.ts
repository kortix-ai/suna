import { describe, expect, test } from 'bun:test';

import {
  LAST_PROJECT_COOKIE,
  clearLastProjectCookieValue,
  isValidProjectId,
  parseLastProjectCookie,
  serializeLastProjectCookie,
} from './last-project-cookie';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('isValidProjectId', () => {
  test('accepts a UUID in either case', () => {
    expect(isValidProjectId(ID)).toBe(true);
    expect(isValidProjectId(ID.toUpperCase())).toBe(true);
  });

  test('rejects everything else', () => {
    for (const bad of ['', 'abc', '../admin', '//evil.com', `${ID}x`, null, undefined]) {
      expect(isValidProjectId(bad as string)).toBe(false);
    }
  });
});

describe('parseLastProjectCookie — path-injection guard', () => {
  test('reads a valid id', () => {
    expect(parseLastProjectCookie(`${LAST_PROJECT_COOKIE}=${ID}`)).toBe(ID);
  });

  test('finds it among other cookies', () => {
    expect(parseLastProjectCookie(`a=1; ${LAST_PROJECT_COOKIE}=${ID}; sidebar_state=true`)).toBe(
      ID,
    );
  });

  test('refuses a traversal or protocol-relative value', () => {
    // This value goes straight into a redirect path. It must never survive.
    for (const bad of [
      '../admin',
      '%2e%2e%2fadmin',
      '//evil.com',
      '/projects/x',
      'http://evil.com',
    ]) {
      expect(parseLastProjectCookie(`${LAST_PROJECT_COOKIE}=${bad}`)).toBeUndefined();
    }
  });

  test('refuses a malformed escape sequence', () => {
    expect(parseLastProjectCookie(`${LAST_PROJECT_COOKIE}=%E0%A4%A`)).toBeUndefined();
  });

  test('returns undefined when absent or empty', () => {
    expect(parseLastProjectCookie('a=1; b=2')).toBeUndefined();
    expect(parseLastProjectCookie('')).toBeUndefined();
    expect(parseLastProjectCookie(null)).toBeUndefined();
    expect(parseLastProjectCookie(undefined)).toBeUndefined();
  });

  test('does not match a different cookie ending in the same name', () => {
    expect(parseLastProjectCookie(`x_${LAST_PROJECT_COOKIE}=${ID}`)).toBeUndefined();
  });
});

describe('serializeLastProjectCookie', () => {
  test('serializes a valid id with a path and samesite', () => {
    const out = serializeLastProjectCookie(ID) ?? '';
    expect(out).toContain(`${LAST_PROJECT_COOKIE}=${ID}`);
    expect(out).toContain('path=/');
    expect(out).toContain('samesite=lax');
  });

  test('refuses to serialize an invalid id', () => {
    expect(serializeLastProjectCookie('../admin')).toBeNull();
    expect(serializeLastProjectCookie('')).toBeNull();
  });

  test('round-trips through the parser', () => {
    const serialized = serializeLastProjectCookie(ID) ?? '';
    expect(parseLastProjectCookie(serialized.split(';')[0])).toBe(ID);
  });

  test('the clear value expires the cookie', () => {
    expect(clearLastProjectCookieValue()).toContain('max-age=0');
  });
});
