import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as crypto from '../lib/crypto';
import * as ownership from '../services/sessions/preview-ownership';
import * as audit from '../services/audit/auth-audit';
import * as sentry from '../lib/sentry';
import * as context from '../lib/request-context';
import * as sso from '../iam/sso-sync';

mock.module('../lib/crypto', () => ({
  ...crypto,
  isServiceAccountToken: (token: string) => token.startsWith('kortix_sa_'),
  isAccountToken: (token: string) => token.startsWith('kortix_pat_'),
  isKortixToken: (token: string) => token.startsWith('kortix_'),
}));
mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async (token: string) => token === 'kortix_sa_valid'
    ? { isValid: true, serviceAccountId: 'sa-1', accountId: 'account-1' }
    : { isValid: false, error: 'Invalid service account' },
}));
mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (token: string) => token === 'kortix_pat_valid'
    ? { isValid: true, userId: 'user-1', accountId: 'account-1', projectId: 'project-1', tokenId: 'pat-1' }
    : { isValid: false, error: 'Invalid PAT' },
}));
mock.module('../repositories/api-keys', () => ({
  validateSecretKey: async (token: string) => token === 'kortix_sb_valid'
    ? { isValid: true, type: 'sandbox', sandboxId: 'sandbox-1', accountId: 'account-1', keyId: 'key-1' }
    : { isValid: false, error: 'Invalid Kortix token' },
}));
mock.module('../oauth/access-token', () => ({
  isOAuthAccessToken: (token: string) => token.startsWith('kortix_oat_'),
  oauthScopeAllowsPath: (scopes: string[]) => scopes.includes('kortix'),
  validateOAuthAccessToken: async (token: string) => token === 'kortix_oat_valid'
    ? { isValid: true, userId: 'user-1', accountId: 'account-1', clientId: 'client-1', scopes: ['kortix'] }
    : { isValid: false, error: 'Invalid OAuth access token' },
}));
mock.module('../auth/jwt-verify', () => ({
  verifySupabaseJwt: async (token: string) => token === 'jwt-valid'
    ? { ok: true, userId: 'user-1', email: 'user@example.test', payload: {} }
    : token === 'jwt-aal2'
      ? { ok: true, userId: 'user-1', email: 'user@example.test', payload: { aal: 'aal2' } }
      : { ok: false, reason: 'invalid-signature' },
  decodeSupabaseJwtPayload: () => null,
}));
mock.module('../services/sessions/preview-ownership', () => ({ ...ownership, canAccessPreviewSandbox: async () => true }));
mock.module('../services/audit/auth-audit', () => ({ ...audit, auditLoginSuccess: () => {}, auditLoginFail: () => {} }));
mock.module('../lib/sentry', () => ({ ...sentry, setSentryUser: () => {} }));
mock.module('../lib/request-context', () => ({ ...context, setContextField: () => {} }));
mock.module('../iam/sso-sync', () => ({ ...sso, syncSsoMembership: async () => {} }));
mock.module('../iam/actor', () => ({ buildActor: async () => null }));

const { supabaseAuth, combinedAuth, apiKeyAuth } = await import('./auth');

function appFor(auth: typeof supabaseAuth) {
  const app = new Hono();
  app.use('/*', auth);
  app.get('/v1/projects/project-1', (c) => c.json({
    userId: c.get('userId' as never) ?? null,
    accountId: c.get('accountId' as never) ?? null,
    authType: c.get('authType' as never) ?? null,
    tokenProjectId: c.get('tokenProjectId' as never) ?? null,
  }));
  app.get('/v1/mfa', (c) => c.json({ mfaAal: c.get('mfaAal' as never) ?? null }));
  app.get('/v1/p/sandbox-1/8000/view', (c) => c.json({
    userId: c.get('userId' as never) ?? null,
    accountId: c.get('accountId' as never) ?? null,
    authType: c.get('authType' as never) ?? null,
    tokenProjectId: c.get('tokenProjectId' as never) ?? null,
  }));
  app.onError((error, c) => c.json({ error: error.message }, error instanceof HTTPException ? error.status : 500));
  return app;
}

describe('auth principal characterization', () => {
  for (const [name, auth] of [['supabaseAuth', supabaseAuth], ['combinedAuth', combinedAuth]] as const) {
    for (const [token, expected] of [
      ['kortix_sa_valid', { userId: 'sa-1', accountId: 'account-1', authType: 'service_account', tokenProjectId: null }],
      ['kortix_pat_valid', { userId: 'user-1', accountId: 'account-1', authType: 'pat', tokenProjectId: 'project-1' }],
      ['kortix_oat_valid', { userId: 'user-1', accountId: 'account-1', authType: 'oauth', tokenProjectId: null }],
      ['jwt-valid', { userId: 'user-1', accountId: null, authType: 'supabase', tokenProjectId: null }],
    ] as const) {
      test(`${name} resolves ${token}`, async () => {
        const response = await appFor(auth).request('/v1/projects/project-1', { headers: { Authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      });
    }
    // MFA gates (`mfaGateBlocks`, the IAM actor) read the token's assurance
    // level. combinedAuth dropped it on the local path, so an account that
    // requires MFA refused an aal2 session there: Teams and Slack `/bind`
    // asked for the code again after every step-up (2026-10-01).
    test(`${name} records the verified token's MFA level`, async () => {
      const response = await appFor(auth).request('/v1/mfa', { headers: { Authorization: 'Bearer jwt-aal2' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mfaAal: 'aal2' });
    });
    test(`${name} rejects missing and malformed credentials`, async () => {
      for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer kortix_pat_invalid' }, { Authorization: 'Bearer jwt-invalid' }] as Record<string, string>[]) {
        const response = await appFor(auth).request('/v1/projects/project-1', { headers });
        expect(response.status).toBe(401);
      }
    });
  }

  test('supabaseAuth accepts a sandbox key only on its allowed sink', async () => {
    const app = new Hono();
    app.use('/*', supabaseAuth);
    app.post('/v1/platform/boot-timeline', (c) => c.json({ userId: c.get('userId' as never), accountId: c.get('accountId' as never), authType: c.get('authType' as never) }));
    const allowed = await app.request('/v1/platform/boot-timeline', { method: 'POST', headers: { Authorization: 'Bearer kortix_sb_valid' } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ userId: 'account-1', accountId: 'account-1', authType: 'apiKey' });
    expect((await appFor(supabaseAuth).request('/v1/projects/project-1', { headers: { Authorization: 'Bearer kortix_sb_valid' } })).status).toBe(401);
  });

  test('combinedAuth resolves preview cookie and rejects project scope on another project', async () => {
    const app = appFor(combinedAuth);
    const cookie = await app.request('/v1/p/sandbox-1/8000/view', { headers: { Cookie: '__preview_session=kortix_sa_valid' } });
    expect(cookie.status).toBe(200);
    expect(await cookie.json()).toEqual({ userId: 'sa-1', accountId: 'account-1', authType: 'service_account', tokenProjectId: null });
    expect((await app.request('/v1/projects/project-2', { headers: { Authorization: 'Bearer kortix_pat_valid' } })).status).toBe(403);
  });

  test('apiKeyAuth accepts a sandbox key and rejects malformed credentials', async () => {
    const app = appFor(apiKeyAuth);
    const valid = await app.request('/v1/projects/project-1', { headers: { Authorization: 'Bearer kortix_sb_valid' } });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ userId: null, accountId: 'account-1', authType: 'apiKey', tokenProjectId: null });
    for (const header of [undefined, 'Bearer ', 'Bearer jwt-valid', 'Bearer kortix_sb_invalid']) {
      expect((await app.request('/v1/projects/project-1', { headers: header ? { Authorization: header } : {} })).status).toBe(401);
    }
  });
});
