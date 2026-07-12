import { beforeEach, describe, expect, mock, test } from 'bun:test';

let verifyResult: unknown;
let networkUser: unknown;

mock.module('../shared/jwt-verify', () => ({
  verifySupabaseJwt: async () => verifyResult,
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: networkUser }, error: networkUser ? null : { message: 'x' } }) },
  }),
}));

const syncCalls: Array<{ userId: string; email: string; jwtPayload: unknown }> = [];
mock.module('../iam/sso-sync', () => ({
  syncSsoMembership: async (args: { userId: string; email: string; jwtPayload: unknown }) => {
    syncCalls.push(args);
    return { skipped: false, memberCreated: true };
  },
}));

mock.module('../shared/auth-audit', () => ({ auditLoginSuccess: () => {}, auditLoginFail: () => {} }));
mock.module('../lib/sentry', () => ({ setSentryUser: () => {} }));
mock.module('../lib/request-context', () => ({ setContextField: () => {} }));

const { supabaseAuth, combinedAuth } = await import('./auth');

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
    verifyResult = undefined;
    networkUser = undefined;
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
