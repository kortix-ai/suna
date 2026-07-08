import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

let secretKeyValidations: string[] = [];

mock.module('../shared/crypto', () => ({
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));

mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async (t: string) => {
    if (t === 'kortix_sa_live') {
      return { isValid: true, serviceAccountId: 'sa-1', accountId: 'acct-1' };
    }
    return { isValid: false, error: 'Invalid service account' };
  },
}));

mock.module('../repositories/api-keys', () => ({
  validateSecretKey: async (t: string) => {
    secretKeyValidations.push(t);
    return { isValid: false, error: 'Invalid Kortix token' };
  },
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async () => ({ isValid: false, error: 'invalid' }),
}));

mock.module('../shared/jwt-verify', () => ({
  verifySupabaseJwt: async () => ({ ok: false }),
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }),
    },
  }),
}));

mock.module('../shared/preview-ownership', () => ({
  canAccessPreviewSandbox: async ({ accountId }: { accountId?: string }) =>
    accountId === 'acct-1',
}));

mock.module('../shared/auth-audit', () => ({
  auditLoginSuccess: () => {},
  auditLoginFail: () => {},
}));

mock.module('../lib/sentry', () => ({ setSentryUser: () => {} }));
mock.module('../lib/request-context', () => ({ setContextField: () => {} }));
mock.module('../iam/sso-sync', () => ({ syncSsoMembership: async () => {} }));

const { combinedAuth, supabaseAuth } = await import('../middleware/auth');

function appWith(middleware: typeof combinedAuth) {
  const app = new Hono();
  app.use('/*', middleware);
  app.get('/probe', (c) =>
    c.json({
      userId: c.get('userId' as never),
      accountId: c.get('accountId' as never),
      authType: c.get('authType' as never),
      iamTokenId: c.get('iamTokenId' as never),
    }),
  );
  return app;
}

describe('combinedAuth accepts service-account bearers', () => {
  beforeEach(() => {
    secretKeyValidations = [];
  });

  test('a valid kortix_sa_ token resolves to a service-account principal', async () => {
    const res = await appWith(combinedAuth).request('/probe', {
      headers: { Authorization: 'Bearer kortix_sa_live' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authType).toBe('service_account');
    expect(body.userId).toBe('sa-1');
    expect(body.accountId).toBe('acct-1');
    expect(body.iamTokenId).toBe('sa-1');
  });

  test('kortix_sa_ never falls through to the generic Kortix-key validator', async () => {
    await appWith(combinedAuth).request('/probe', {
      headers: { Authorization: 'Bearer kortix_sa_live' },
    });
    await appWith(combinedAuth).request('/probe', {
      headers: { Authorization: 'Bearer kortix_sa_bogus' },
    });

    expect(secretKeyValidations).toEqual([]);
  });

  test('an invalid kortix_sa_ token 401s with the service-account error, not the generic key error', async () => {
    const res = await appWith(combinedAuth).request('/probe', {
      headers: { Authorization: 'Bearer kortix_sa_bogus' },
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Invalid service account');
  });

  test('supabaseAuth and combinedAuth resolve the same SA token to the same principal', async () => {
    const [a, b] = await Promise.all([
      appWith(supabaseAuth).request('/probe', {
        headers: { Authorization: 'Bearer kortix_sa_live' },
      }),
      appWith(combinedAuth).request('/probe', {
        headers: { Authorization: 'Bearer kortix_sa_live' },
      }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
  });
});
