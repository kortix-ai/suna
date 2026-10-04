// The App viewer: a per-App secret, a signed identity that only that App can
// verify, and the scope ladder that decides how much the App is told.

import { describe, expect, test } from 'bun:test';
import {
  appViewerScopes,
  appViewerSecret,
  encodeAppViewerContext,
  normalizeViewerTokenScope,
  verifyAppViewerContext,
} from './viewer';

const APP_A = '11111111-1111-4111-8111-111111111111';
const APP_B = '22222222-2222-4222-8222-222222222222';

const payload = {
  appId: APP_A,
  userId: '33333333-3333-4333-8333-333333333333',
  email: 'viewer@example.test',
  groupIds: ['44444444-4444-4444-8444-444444444444'],
  accountId: '55555555-5555-4555-8555-555555555555',
  accessMode: 'restricted',
};

describe('appViewerSecret', () => {
  test('is stable per App, different across Apps, and is never the platform secret', () => {
    const a = appViewerSecret(APP_A);
    expect(appViewerSecret(APP_A)).toBe(a);
    expect(appViewerSecret(APP_B)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain(process.env.API_KEY_SECRET ?? 'no-secret-configured');
  });
});

describe('the signed viewer context', () => {
  test('round-trips identity through the App’s own secret', () => {
    const token = encodeAppViewerContext(payload, appViewerSecret(APP_A));
    const result = verifyAppViewerContext(token, appViewerSecret(APP_A));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.viewer).toMatchObject({
      v: 1,
      appId: APP_A,
      userId: payload.userId,
      email: 'viewer@example.test',
      groupIds: payload.groupIds,
      accountId: payload.accountId,
      accessMode: 'restricted',
    });
    expect(result.viewer.exp).toBeGreaterThan(result.viewer.iat);
  });

  test('another App cannot verify it — one App can never speak for another', () => {
    const token = encodeAppViewerContext(payload, appViewerSecret(APP_A));
    expect(verifyAppViewerContext(token, appViewerSecret(APP_B))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('a tampered payload is refused, not merely re-read', () => {
    const token = encodeAppViewerContext(payload, appViewerSecret(APP_A));
    const [body, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    forged.userId = '99999999-9999-4999-8999-999999999999';
    const tampered = `${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${sig}`;
    expect(verifyAppViewerContext(tampered, appViewerSecret(APP_A)).ok).toBe(false);
  });

  test('an expired context is refused', () => {
    const token = encodeAppViewerContext({ ...payload, ttlSeconds: -1 }, appViewerSecret(APP_A));
    expect(verifyAppViewerContext(token, appViewerSecret(APP_A))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  test('malformed input never throws', () => {
    const secret = appViewerSecret(APP_A);
    for (const bad of [null, undefined, '', 'nodot', 'a.b.c']) {
      expect(verifyAppViewerContext(bad as never, secret).ok).toBe(false);
    }
  });
});

describe('viewer token scope', () => {
  test('identity is the default and never carries the API scope', () => {
    expect(normalizeViewerTokenScope(undefined)).toBe('identity');
    expect(normalizeViewerTokenScope('nonsense')).toBe('identity');
    expect(appViewerScopes('identity')).toEqual(['profile', 'email']);
    expect(appViewerScopes('identity')).not.toContain('kortix');
  });
  test('api adds `kortix`; off shares nothing', () => {
    expect(normalizeViewerTokenScope('api')).toBe('api');
    expect(appViewerScopes('api')).toEqual(['profile', 'email', 'kortix']);
    expect(normalizeViewerTokenScope('off')).toBe('off');
    expect(appViewerScopes('off')).toEqual([]);
  });
});
