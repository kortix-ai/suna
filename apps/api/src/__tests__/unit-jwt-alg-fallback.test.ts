import { describe, expect, test } from 'bun:test';

import { isInconclusiveVerifyFailure, verifySupabaseJwt } from '../shared/jwt-verify';

/**
 * Regression cover for the 2026-08-21 prod near-miss.
 *
 * A project that has not been onboarded to Supabase signing keys publishes an
 * EMPTY JWKS, so `keyCache` stays empty and every token takes the `no-keys`
 * network fallback. The moment an asymmetric key is published — which happens
 * as soon as the legacy secret is imported, before anything is promoted — the
 * cache is no longer empty. Legacy HS256 tokens carry no `kid`, the key lookup
 * fell through to "first key in the cache", and the algorithm check then failed
 * as `unsupported-alg:HS256`, which the auth middleware treats as a definitive
 * rejection. Result: 401 on a perfectly valid session.
 */
describe('isInconclusiveVerifyFailure', () => {
  test('an algorithm this verifier cannot check is inconclusive, not a rejection', () => {
    expect(isInconclusiveVerifyFailure('unsupported-alg:HS256')).toBe(true);
    expect(isInconclusiveVerifyFailure('unsupported-alg:EdDSA')).toBe(true);
  });

  test('a missing or unknown key is inconclusive', () => {
    expect(isInconclusiveVerifyFailure('no-keys')).toBe(true);
    expect(isInconclusiveVerifyFailure('no-key-for-kid')).toBe(true);
  });

  test('a real verdict is never treated as inconclusive', () => {
    for (const reason of [
      'bad-signature',
      'expired',
      'malformed',
      'bad-header',
      'bad-payload',
      'no-sub',
      'verify-error',
    ]) {
      expect(isInconclusiveVerifyFailure(reason)).toBe(false);
    }
  });
});

describe('verifySupabaseJwt — legacy symmetric tokens', () => {
  function jwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString('base64url').replace(/=+$/, '');
    return `${b64(header)}.${b64(payload)}.c2ln`;
  }

  test('an HS256 token WITHOUT a kid never resolves to an asymmetric key', async () => {
    const token = jwt(
      { alg: 'HS256', typ: 'JWT' },
      { sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 },
    );

    const result = await verifySupabaseJwt(token);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Whatever the cache holds, this must be routed to the network path.
    expect(isInconclusiveVerifyFailure(result.reason)).toBe(true);
  });

  test('an HS256 token WITH a kid is also routed to the network path', async () => {
    const token = jwt(
      { alg: 'HS256', kid: '4xe2F7ZWjt3F1l/w', typ: 'JWT' },
      { sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 },
    );

    const result = await verifySupabaseJwt(token);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(isInconclusiveVerifyFailure(result.reason)).toBe(true);
  });

  test('a malformed token is still a definitive rejection', async () => {
    const result = await verifySupabaseJwt('not-a-jwt');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(isInconclusiveVerifyFailure(result.reason)).toBe(false);
  });
});
