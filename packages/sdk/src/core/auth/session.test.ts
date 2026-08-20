import { describe, expect, test } from 'bun:test';

import { decodeJwtExp, isJwtExpired, normalizeSession } from './session';

/** Build a JWT whose payload is exactly `payload`. Signature is irrelevant —
 *  nothing here verifies it; the server is the judge. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: string) =>
    Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${encode(JSON.stringify(payload))}.sig`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('decodeJwtExp', () => {
  test('reads a numeric exp claim', () => {
    expect(decodeJwtExp(jwt({ exp: 1770000000 }))).toBe(1770000000);
  });

  test('decodes a base64url payload containing - and _', () => {
    // A payload whose standard-base64 encoding contains '+' and '/' becomes
    // '-' and '_' in base64url. A decoder that forgets the substitution throws
    // and the token silently reads as "never expires".
    const payload = { exp: 1770000000, sub: 'a?~ÿ>>>???', role: 'authenticated' };
    const token = jwt(payload);
    expect(token.split('.')[1]).toMatch(/[-_]/);
    expect(decodeJwtExp(token)).toBe(1770000000);
  });

  test('returns null when the token has no payload segment', () => {
    expect(decodeJwtExp('not-a-jwt')).toBeNull();
  });

  test('returns null for a non-numeric or missing exp', () => {
    expect(decodeJwtExp(jwt({ exp: 'soon' }))).toBeNull();
    expect(decodeJwtExp(jwt({ sub: 'u1' }))).toBeNull();
  });

  test('returns null for an unparseable payload', () => {
    expect(decodeJwtExp('a.@@@not-base64@@@.c')).toBeNull();
  });
});

describe('isJwtExpired', () => {
  test('honours the 30 s skew: a token expiring in 20 s counts as expired', () => {
    expect(isJwtExpired(jwt({ exp: nowSeconds() + 20 }))).toBe(true);
    expect(isJwtExpired(jwt({ exp: nowSeconds() + 300 }))).toBe(false);
  });

  test('accepts an explicit skew', () => {
    const token = jwt({ exp: nowSeconds() + 20 });
    expect(isJwtExpired(token, 0)).toBe(false);
    expect(isJwtExpired(token, 60)).toBe(true);
  });

  test('an already-past exp is expired at any skew', () => {
    expect(isJwtExpired(jwt({ exp: nowSeconds() - 1 }), 0)).toBe(true);
  });

  test('an unparseable token is NOT expired — use it, let the server judge', () => {
    // Ported deliberately from apps/web/src/lib/auth-token.ts:134-149. Discarding
    // a token we merely cannot read signs a working user out.
    expect(isJwtExpired('not-a-jwt')).toBe(false);
    expect(isJwtExpired(jwt({ sub: 'u1' }))).toBe(false);
    expect(isJwtExpired(jwt({ exp: 'soon' }))).toBe(false);
  });
});

describe('normalizeSession', () => {
  test('derives expires_at from expires_in when GoTrue omits it', () => {
    const before = nowSeconds();
    const session = normalizeSession({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'bearer',
      expires_in: 3600,
      user: { id: 'u1', email: 'a@b.test' },
    });
    expect(session.expires_at).toBeGreaterThanOrEqual(before + 3600);
    expect(session.expires_at).toBeLessThanOrEqual(nowSeconds() + 3600);
    expect(session.user?.id).toBe('u1');
    expect(session.token_type).toBe('bearer');
  });

  test('keeps an explicit expires_at and defaults token_type to bearer', () => {
    const session = normalizeSession({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: 1770000000,
      user: null,
    });
    expect(session.expires_at).toBe(1770000000);
    expect(session.token_type).toBe('bearer');
    expect(session.user).toBeNull();
  });

  test('rejects a payload with no access_token', () => {
    expect(() => normalizeSession({ refresh_token: 'r' })).toThrow(/access_token/);
  });
});
