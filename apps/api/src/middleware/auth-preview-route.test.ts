// `combinedAuth` on the path-form preview proxy (`/v1/p/:sandboxId/:port/*`):
// which credential shapes it accepts, and how the ownership verdict maps to
// 401/403/200 for each token branch. The ownership RULE itself runs on real
// rows in __tests__/integration-preview-access.test.ts; here it is a verdict
// this suite chooses.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realCrypto from '../shared/crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as realPreviewOwnership from '../shared/preview-ownership';

/** The account that owns every sandbox here, or null for "no such sandbox". */
let mockSandboxAccountId: string | null = 'acct-owner';
let mockSupabaseUser: { id: string; email?: string } | null = null;
/** Signed-in people who belong to the owning account. */
const OWNING_USERS = new Set(['user-owner', 'user-fallback-owner']);

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits.
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async ({ accountId, userId }: { accountId?: string; userId?: string }) => {
    if (!mockSandboxAccountId) return false;
    if (accountId) return accountId === mockSandboxAccountId;
    return !!userId && OWNING_USERS.has(userId);
  },
  // Not exercised by this suite (no project-scoped PATs here).
  resolveSandboxProjectId: async () => null,
}));

mock.module('../repositories/api-keys', () => ({
  validateSecretKey: async (token: string) => {
    if (token === 'kortix_owner') {
      return { isValid: true, accountId: 'acct-owner' };
    }
    if (token === 'kortix_other') {
      return { isValid: true, accountId: 'acct-other' };
    }
    return { isValid: false, error: 'Invalid Kortix token' };
  },
}));

mock.module('../shared/crypto', () => ({
  // Spread the real module: mock.module replaces it WHOLESALE, and the auth
  // middleware also reaches shared/crypto through oauth/token-hash. Only the
  // token-kind predicates this suite's fake tokens need are overridden.
  ...realCrypto,
  isKortixToken: (token: string) => token.startsWith('kortix_'),
  isAccountToken: (token: string) => token.startsWith('kortix_pat_'),
  isServiceAccountToken: (token: string) => token.startsWith('kortix_sa_'),
  isTunnelToken: (token: string) => token.startsWith('kortix_tun_'),
  isApiKeySecretConfigured: () => true,
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async () => ({ isValid: false, error: 'Invalid PAT' }),
}));

mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async (token: string) => {
    if (token === 'jwt-owner') {
      return { ok: true, userId: 'user-owner', email: 'owner@kortix.dev' };
    }
    if (token === 'jwt-other') {
      return { ok: true, userId: 'user-other', email: 'other@kortix.dev' };
    }
    if (token === 'jwt-fallback-owner' || token === 'jwt-fallback-other') {
      return { ok: false, reason: 'no-keys' };
    }
    return { ok: false, reason: 'invalid' };
  },
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getUser: async () => ({ data: { user: mockSupabaseUser }, error: mockSupabaseUser ? null : { message: 'invalid' } }),
    },
  }),
}));

mock.module('../config', () => ({
  config: {
    isLocal: () => false,
  },
}));

const { combinedAuth } = await import('./auth');

function createApp() {
  const app = new Hono();
  app.use('/v1/p/:sandboxId/:port/*', combinedAuth);
  app.use('/v1/p/share', combinedAuth);
  app.get('/v1/p/:sandboxId/:port/*', (c) => c.json({ ok: true }));
  app.post('/v1/p/share', (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ message: err.message }, err.status);
    }
    return c.json({ message: 'Internal server error' }, 500);
  });
  return app;
}

beforeEach(() => {
  mockSandboxAccountId = 'acct-owner';
  mockSupabaseUser = null;
});

describe('preview auth ownership', () => {
  test('rejects request without auth token', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status');
    expect(res.status).toBe(401);
  });

  test('allows owner via Bearer kortix token', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer kortix_owner' },
    });
    expect(res.status).toBe(200);
  });

  test('allows owner via X-Kortix-Token header', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { 'X-Kortix-Token': 'kortix_owner' },
    });
    expect(res.status).toBe(200);
  });

  test('allows owner via preview session cookie with kortix token', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Cookie: '__preview_session=kortix_owner' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects query-string bearer tokens on ordinary HTTP preview routes', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status?token=kortix_owner');
    expect(res.status).toBe(401);
  });

  test('rejects non-owner kortix token', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer kortix_other' },
    });
    expect(res.status).toBe(403);
  });

  test('rejects invalid X-Kortix-Token', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { 'X-Kortix-Token': 'kortix_invalid' },
    });
    expect(res.status).toBe(401);
  });

  test('allows jwt owner with matching account ownership', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer jwt-owner' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects jwt user without ownership', async () => {
    const app = createApp();
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer jwt-other' },
    });
    expect(res.status).toBe(403);
  });

  test('allows jwt owner via Supabase fallback path', async () => {
    const app = createApp();
    mockSupabaseUser = { id: 'user-fallback-owner', email: 'fallback@kortix.dev' };
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer jwt-fallback-owner' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects jwt via Supabase fallback without ownership', async () => {
    const app = createApp();
    mockSupabaseUser = { id: 'user-fallback-other', email: 'other@kortix.dev' };
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer jwt-fallback-other' },
    });
    expect(res.status).toBe(403);
  });

  test('does not treat /v1/p/share as a sandbox ownership route', async () => {
    const app = createApp();
    mockSandboxAccountId = null;
    const res = await app.request('/v1/p/share', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_owner' },
    });
    expect(res.status).toBe(200);
  });
});
