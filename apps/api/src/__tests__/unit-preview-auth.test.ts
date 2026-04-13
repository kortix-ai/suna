import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

let mockSandboxAccountId: string | null = 'acct-owner';
let mockResolvedAccountId = 'acct-owner';
let mockSupabaseUser: { id: string; email?: string } | null = null;

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (mockSandboxAccountId ? [{ accountId: mockSandboxAccountId }] : []),
        }),
      }),
    }),
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => mockResolvedAccountId,
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
  isKortixToken: (token: string) => token.startsWith('kortix_'),
}));

mock.module('../shared/jwt-verify', () => ({
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

mock.module('../config', () => ({ config: {} }));

const { combinedAuth } = await import('../middleware/auth');
const { clearPreviewOwnershipCache } = await import('../shared/preview-ownership');

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
  mockResolvedAccountId = 'acct-owner';
  mockSupabaseUser = null;
  clearPreviewOwnershipCache();
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
    mockResolvedAccountId = 'acct-owner';
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer jwt-owner' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects jwt user without ownership', async () => {
    const app = createApp();
    mockResolvedAccountId = 'acct-other';
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer jwt-other' },
    });
    expect(res.status).toBe(403);
  });

  test('allows jwt owner via preview session cookie', async () => {
    const app = createApp();
    mockResolvedAccountId = 'acct-owner';
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Cookie: '__preview_session=jwt-owner' },
    });
    expect(res.status).toBe(200);
  });

  test('allows jwt owner via Supabase fallback path', async () => {
    const app = createApp();
    mockResolvedAccountId = 'acct-owner';
    mockSupabaseUser = { id: 'user-fallback-owner', email: 'fallback@kortix.dev' };
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer jwt-fallback-owner' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects jwt via Supabase fallback without ownership', async () => {
    const app = createApp();
    mockResolvedAccountId = 'acct-other';
    mockSupabaseUser = { id: 'user-fallback-other', email: 'other@kortix.dev' };
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer jwt-fallback-other' },
    });
    expect(res.status).toBe(403);
  });

  test('rejects access when sandbox cannot be resolved', async () => {
    const app = createApp();
    mockSandboxAccountId = null;
    const res = await app.request('/v1/p/8c70e5be-2f95-45ae-bd8d-5d07b65c631b/8000/session/status', {
      headers: { Authorization: 'Bearer kortix_owner' },
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
