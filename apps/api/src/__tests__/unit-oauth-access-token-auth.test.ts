// Sign in with Kortix: a `kortix_oat_` OAuth access token is a first-class
// credential on every auth middleware, resolving to the user who granted it.
// The `kortix` scope is what opens the general API; without it the token
// reaches only the identity probes (`/v1/accounts/me`, `/v1/oauth/userinfo`).

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as realPreviewOwnership from '../shared/preview-ownership';
import * as realRequestContext from '../lib/request-context';
import * as realAuthAudit from '../shared/auth-audit';
import * as realSentry from '../lib/sentry';
import * as realSsoSync from '../iam/sso-sync';
import * as realCrypto from '../shared/crypto';

let secretKeyValidations: string[] = [];
let oauthValidations: string[] = [];

mock.module('../shared/crypto', () => ({
  ...realCrypto,
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));

mock.module('../oauth/access-token', () => ({
  isOAuthAccessToken: (t: string) => t.startsWith('kortix_oat_'),
  oauthScopeAllowsPath: (scopes: string[], path: string) =>
    scopes.includes('kortix') || path === '/v1/accounts/me' || path === '/v1/oauth/userinfo',
  validateOAuthAccessToken: async (t: string) => {
    oauthValidations.push(t);
    if (t === 'kortix_oat_full') {
      return {
        isValid: true,
        tokenId: 'oat-1',
        userId: 'user-1',
        accountId: 'acct-1',
        clientId: 'client-1',
        scopes: ['profile', 'kortix'],
      };
    }
    if (t === 'kortix_oat_profile_only') {
      return {
        isValid: true,
        tokenId: 'oat-2',
        userId: 'user-1',
        accountId: 'acct-1',
        clientId: 'client-1',
        scopes: ['profile'],
      };
    }
    return { isValid: false, error: 'Invalid OAuth access token' };
  },
}));

mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async () => ({ isValid: false, error: 'Invalid service account' }),
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
  decodeSupabaseJwtPayload: () => null,
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
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async () => true,
  resolveSandboxProjectId: async () => null,
}));

mock.module('../shared/auth-audit', () => ({
  ...realAuthAudit,
  auditLoginSuccess: () => {},
  auditLoginFail: () => {},
}));

mock.module('../lib/sentry', () => ({ ...realSentry, setSentryUser: () => {} }));
mock.module('../lib/request-context', () => ({ ...realRequestContext, setContextField: () => {} }));
mock.module('../iam/sso-sync', () => ({ ...realSsoSync, syncSsoMembership: async () => {} }));

const { combinedAuth, supabaseAuth } = await import('../middleware/auth');

function appWith(middleware: typeof combinedAuth) {
  const app = new Hono();
  app.use('/*', middleware);
  const probe = (c: any) =>
    c.json({
      userId: c.get('userId'),
      accountId: c.get('accountId'),
      authType: c.get('authType'),
      iamTokenId: c.get('iamTokenId') ?? null,
      oauthClientId: c.get('oauthClientId') ?? null,
      oauthScopes: c.get('oauthScopes') ?? null,
    });
  app.get('/v1/projects', probe);
  app.get('/v1/accounts/me', probe);
  app.get('/v1/oauth/userinfo', probe);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: (err as Error).message }, 500);
  });
  return app;
}

describe('OAuth access tokens on the auth middlewares', () => {
  beforeEach(() => {
    secretKeyValidations = [];
    oauthValidations = [];
  });

  test('a `kortix` -scoped token acts as the granting user on the general API', async () => {
    const res = await appWith(combinedAuth).request('/v1/projects', {
      headers: { Authorization: 'Bearer kortix_oat_full' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: 'user-1',
      accountId: 'acct-1',
      authType: 'oauth',
      iamTokenId: null,
      oauthClientId: 'client-1',
      oauthScopes: ['profile', 'kortix'],
    });
  });

  test('never falls through to the generic Kortix-key validator', async () => {
    await appWith(combinedAuth).request('/v1/projects', {
      headers: { Authorization: 'Bearer kortix_oat_full' },
    });
    await appWith(combinedAuth).request('/v1/projects', {
      headers: { Authorization: 'Bearer kortix_oat_bogus' },
    });
    expect(secretKeyValidations).toEqual([]);
    expect(oauthValidations).toEqual(['kortix_oat_full', 'kortix_oat_bogus']);
  });

  test('an invalid token 401s with the OAuth error', async () => {
    const res = await appWith(combinedAuth).request('/v1/projects', {
      headers: { Authorization: 'Bearer kortix_oat_bogus' },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Invalid OAuth access token');
  });

  test('a profile-only token is 403 insufficient_scope on the general API but reaches the identity probes', async () => {
    const app = appWith(supabaseAuth);
    const denied = await app.request('/v1/projects', {
      headers: { Authorization: 'Bearer kortix_oat_profile_only' },
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('insufficient_scope');

    const me = await app.request('/v1/accounts/me', {
      headers: { Authorization: 'Bearer kortix_oat_profile_only' },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).authType).toBe('oauth');
  });

  test('supabaseAuth and combinedAuth resolve the same token to the same principal', async () => {
    const [a, b] = await Promise.all([
      appWith(supabaseAuth).request('/v1/projects', {
        headers: { Authorization: 'Bearer kortix_oat_full' },
      }),
      appWith(combinedAuth).request('/v1/projects', {
        headers: { Authorization: 'Bearer kortix_oat_full' },
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
  });
});
