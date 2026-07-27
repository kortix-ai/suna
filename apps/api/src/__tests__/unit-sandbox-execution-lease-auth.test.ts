import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

mock.module('../shared/crypto', () => ({
  isAccountToken: () => false,
  isServiceAccountToken: () => false,
  isKortixToken: (token: string) => token === 'kortix_sb_execution_lease',
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async () => ({ isValid: false }),
}));

mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async () => ({ isValid: false }),
}));

mock.module('../repositories/api-keys', () => ({
  validateSecretKey: async (token: string) =>
    token === 'kortix_sb_execution_lease'
      ? {
          isValid: true,
          type: 'sandbox',
          sandboxId: 'sandbox-1',
          accountId: 'account-1',
          keyId: 'key-1',
        }
      : { isValid: false, error: 'Invalid token' },
}));

mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async () => ({ ok: false, reason: 'no-keys' }),
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getUser: async () => ({
        data: { user: null },
        error: { message: 'invalid' },
      }),
    },
  }),
}));

mock.module('../shared/auth-audit', () => ({
  auditLoginSuccess: () => {},
  auditLoginFail: () => {},
}));

mock.module('../lib/sentry', () => ({ setSentryUser: () => {} }));
mock.module('../lib/request-context', () => ({ setContextField: () => {} }));
mock.module('../iam/sso-sync', () => ({ syncSsoMembership: async () => {} }));

const { supabaseAuth } = await import('../middleware/auth');

function createApp() {
  const app = new Hono();
  app.use('/*', supabaseAuth);
  app.post('/v1/projects/:projectId/execution-lease', (c) =>
    c.json({
      authType: c.get('authType' as never),
      apiKeyType: c.get('apiKeyType' as never),
      accountId: c.get('accountId' as never),
      sandboxId: c.get('sandboxId' as never),
    }),
  );
  app.post('/v1/projects/:projectId/not-sandbox-enabled', (c) => c.json({ ok: true }));
  return app;
}

describe('sandbox execution-lease authentication', () => {
  test('accepts a valid sandbox token and sets its scoped identity', async () => {
    const response = await createApp().request(
      '/v1/projects/project-1/execution-lease',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer kortix_sb_execution_lease' },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authType: 'apiKey',
      apiKeyType: 'sandbox',
      accountId: 'account-1',
      sandboxId: 'sandbox-1',
    });
  });

  test('rejects the same sandbox token on an unrelated project route', async () => {
    const response = await createApp().request(
      '/v1/projects/project-1/not-sandbox-enabled',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer kortix_sb_execution_lease' },
      },
    );

    expect(response.status).toBe(401);
  });
});
