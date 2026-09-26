import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realRequestContext from '../lib/request-context';
import * as realAuthAudit from '../shared/auth-audit';
import * as realSentry from '../lib/sentry';
import * as realSsoSync from '../iam/sso-sync';

let verifyResult: unknown;
let networkUser: unknown;

mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async () => verifyResult,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: networkUser }, error: networkUser ? null : { message: 'x' } }) },
  }),
}));

const syncCalls: Array<{ userId: string; email: string; jwtPayload: unknown }> = [];
let syncFailure: Error | null = null;
mock.module('../iam/sso-sync', () => ({
  ...realSsoSync,
  syncSsoMembership: async (args: { userId: string; email: string; jwtPayload: unknown }) => {
    syncCalls.push(args);
    if (syncFailure) throw syncFailure;
    return { skipped: false, memberCreated: true };
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../shared/auth-audit', () => ({ ...realAuthAudit, ...realAuthAudit, auditLoginSuccess: () => {}, auditLoginFail: () => {} }));
mock.module('../lib/sentry', () => ({ ...realSentry, setSentryUser: () => {} }));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../lib/request-context', () => ({ ...realRequestContext, setContextField: () => {} }));

const { supabaseAuth, combinedAuth, clearSsoSyncMemo } = await import('./auth');

const SSO_PAYLOAD = { app_metadata: { provider: 'sso:prov-123', providers: ['sso:prov-123'] } };

function ctx(token: string, path = '/v1/accounts') {
  const store = new Map<string, unknown>();
  return {
    ctx: {
      req: {
        header: (h: string) => (h === 'Authorization' ? `Bearer ${token}` : undefined),
        path,
        method: 'GET',
      },
      set: (k: string, v: unknown) => store.set(k, v),
      get: (k: string) => store.get(k),
    } as never,
    store,
  };
}

const JWT = 'eyJhbGciOiJSUzI1NiJ9.body.sig';

describe('auth middleware runs SAML JIT sync on every Supabase-JWT path', () => {
  beforeEach(() => {
    syncCalls.length = 0;
    syncFailure = null;
    verifyResult = undefined;
    networkUser = undefined;
    clearSsoSyncMemo();
  });

  test('supabaseAuth LOCAL path syncs', async () => {
    verifyResult = { ok: true, userId: 'u1', email: 'u1@corp.com', payload: SSO_PAYLOAD };
    const { ctx: c } = ctx(JWT);
    await supabaseAuth(c, async () => {});
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].userId).toBe('u1');
    expect((syncCalls[0].jwtPayload as typeof SSO_PAYLOAD).app_metadata.provider).toBe('sso:prov-123');
  });

  test('supabaseAuth NETWORK-fallback path syncs (the regression: kid not in cached JWKS)', async () => {
    verifyResult = { ok: false, reason: 'no-key-for-kid' };
    networkUser = { id: 'u2', email: 'u2@corp.com', ...SSO_PAYLOAD };
    const { ctx: c } = ctx(JWT);
    await supabaseAuth(c, async () => {});
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].userId).toBe('u2');
    expect((syncCalls[0].jwtPayload as typeof SSO_PAYLOAD).app_metadata.provider).toBe('sso:prov-123');
  });

  test('combinedAuth LOCAL path syncs', async () => {
    verifyResult = { ok: true, userId: 'u3', email: 'u3@corp.com', payload: SSO_PAYLOAD };
    const { ctx: c } = ctx(JWT);
    await combinedAuth(c, async () => {});
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].userId).toBe('u3');
  });

  test('combinedAuth NETWORK-fallback path syncs', async () => {
    verifyResult = { ok: false, reason: 'no-key-for-kid' };
    networkUser = { id: 'u4', email: 'u4@corp.com', ...SSO_PAYLOAD };
    const { ctx: c } = ctx(JWT);
    await combinedAuth(c, async () => {});
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].userId).toBe('u4');
  });
});

describe('SAML JIT sync runs once per login session, not once per request', () => {
  const session = (sessionId: string, groups: string[] = []) => ({
    session_id: sessionId,
    iat: 1_700_000_000,
    app_metadata: { provider: 'sso:prov-123', providers: ['sso:prov-123'] },
    user_metadata: { custom_claims: { groups } },
  });
  const request = async (userId: string, payload: unknown) => {
    verifyResult = { ok: true, userId, email: `${userId}@corp.com`, payload };
    const { ctx: c } = ctx(JWT);
    await supabaseAuth(c, async () => {});
  };

  beforeEach(() => {
    syncCalls.length = 0;
    syncFailure = null;
    verifyResult = undefined;
    networkUser = undefined;
    clearSsoSyncMemo();
  });

  test('repeated requests of one login session sync once', async () => {
    for (let i = 0; i < 5; i++) await request('m1', session('s1'));
    expect(syncCalls).toHaveLength(1);
  });

  test('a new login session syncs again', async () => {
    await request('m2', session('s1'));
    await request('m2', session('s2'));
    expect(syncCalls).toHaveLength(2);
  });

  test('new IdP claims in the same session sync again', async () => {
    await request('m3', session('s1', ['a']));
    await request('m3', session('s1', ['a', 'b']));
    expect(syncCalls).toHaveLength(2);
  });

  test('a failed sync is retried on the next request', async () => {
    syncFailure = new Error('advisory lock timeout');
    await request('m4', session('s1'));
    syncFailure = null;
    await request('m4', session('s1'));
    await request('m4', session('s1'));
    expect(syncCalls).toHaveLength(2);
  });

  test('a token without a login session is never remembered', async () => {
    await request('m5', { app_metadata: { provider: 'sso:prov-123' } });
    await request('m5', { app_metadata: { provider: 'sso:prov-123' } });
    expect(syncCalls).toHaveLength(2);
  });
});
