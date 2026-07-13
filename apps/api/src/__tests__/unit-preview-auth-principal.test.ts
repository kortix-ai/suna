/**
 * Unit tests for the unified preview-token authenticator
 * (sandbox-proxy/preview-auth.ts) used by the subdomain + WebSocket proxy edges.
 *
 * The point of this module is that EVERY non-Hono edge accepts the same set of
 * credentials as combinedAuth. These tests lock that matrix in — in particular
 * the two token types that the old per-edge validators silently rejected:
 *   - CLI Personal Access Tokens (kortix_pat_…)   [subdomain used to reject]
 *   - Service-account tokens      (kortix_sa_…)    [subdomain + WS rejected]
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

const SANDBOX_ID = 'sandbox-xyz';
let allowedAccounts = new Set<string>(['acct-owner']);
let allowedUsers = new Set<string>(['user-owner', 'sa-owner', 'pat-user-owner', 'user-fallback-owner']);
let mockSupabaseUser: { id: string } | null = null;

mock.module('../shared/crypto', () => ({
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));

mock.module('../repositories/api-keys', () => ({
  createApiKey: async () => { throw new Error('not used'); },
  listApiKeys: async () => [],
  revokeApiKey: async () => false,
  deleteApiKey: async () => false,
  validateSecretKey: async (t: string) => {
    if (t === 'kortix_owner') return { isValid: true, accountId: 'acct-owner' };
    if (t === 'kortix_other') return { isValid: true, accountId: 'acct-other' };
    return { isValid: false, error: 'invalid' };
  },
}));

mock.module('../repositories/account-tokens', () => ({
  PatPolicyError: class PatPolicyError extends Error {},
  createAccountToken: async () => { throw new Error('not used'); },
  listAccountTokens: async () => [],
  revokeAccountToken: async () => false,
  revokeAllAccountTokensForUser: async () => 0,
  validateAccountToken: async (t: string) => {
    if (t === 'kortix_pat_owner') return { isValid: true, userId: 'pat-user-owner' };
    if (t === 'kortix_pat_other') return { isValid: true, userId: 'pat-user-other' };
    return { isValid: false, error: 'invalid' };
  },
}));

mock.module('../repositories/service-accounts', () => ({
  listServiceAccounts: async () => [],
  getServiceAccount: async () => null,
  createServiceAccount: async () => { throw new Error('not used'); },
  listAgentServiceAccounts: async () => [],
  ensureAgentServiceAccount: async () => null,
  disableServiceAccount: async () => false,
  deleteServiceAccount: async () => false,
  validateServiceAccountToken: async (t: string) => {
    if (t === 'kortix_sa_owner') {
      return { isValid: true, serviceAccountId: 'sa-owner', accountId: 'acct-owner' };
    }
    return { isValid: false, error: 'invalid' };
  },
}));

mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async (t: string) => {
    if (t === 'jwt-owner') return { ok: true, userId: 'user-owner' };
    if (t === 'jwt-other') return { ok: true, userId: 'user-other' };
    if (t === 'jwt-fallback') return { ok: false, reason: 'no-keys' };
    return { ok: false, reason: 'invalid' };
  },
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getUser: async () => ({
        data: { user: mockSupabaseUser },
        error: mockSupabaseUser ? null : { message: 'invalid' },
      }),
    },
  }),
}));

mock.module('../shared/preview-ownership', () => ({
  canAccessPreviewSandbox: async ({ userId, accountId }: { userId?: string; accountId?: string }) => {
    if (accountId && allowedAccounts.has(accountId)) return true;
    if (userId && allowedUsers.has(userId)) return true;
    return false;
  },
  resolvePreviewUserContext: async (_previewSandboxId: string, userId?: string) =>
    userId && allowedUsers.has(userId)
      ? { userId, sandboxId: SANDBOX_ID, sandboxRole: 'member', scopes: ['*'] }
      : null,
  canAccessSandboxSession: async () => true,
}));

const { authenticatePreviewPrincipal, extractPreviewToken } = await import('../sandbox-proxy/preview-auth');
const { previewSubdomainAuthCacheKeyForTest } = await import('../sandbox-proxy/subdomain');

beforeEach(() => {
  allowedAccounts = new Set(['acct-owner']);
  allowedUsers = new Set(['user-owner', 'sa-owner', 'pat-user-owner', 'user-fallback-owner']);
  mockSupabaseUser = null;
});

describe('authenticatePreviewPrincipal', () => {
  test('returns null for empty token', async () => {
    expect(await authenticatePreviewPrincipal(null, SANDBOX_ID)).toBeNull();
    expect(await authenticatePreviewPrincipal('', SANDBOX_ID)).toBeNull();
  });

  // ── PAT (kortix_pat_) — was rejected by the subdomain edge before ──────────
  test('accepts a PAT for an owner and returns the user id', async () => {
    expect(await authenticatePreviewPrincipal('kortix_pat_owner', SANDBOX_ID)).toBe('pat-user-owner');
  });
  test('rejects a valid PAT that lacks sandbox access', async () => {
    expect(await authenticatePreviewPrincipal('kortix_pat_other', SANDBOX_ID)).toBeNull();
  });
  test('rejects an invalid PAT', async () => {
    expect(await authenticatePreviewPrincipal('kortix_pat_bad', SANDBOX_ID)).toBeNull();
  });

  // ── Service-account (kortix_sa_) — was rejected by subdomain AND WS ────────
  test('accepts a service-account token for an owner and returns the SA id', async () => {
    expect(await authenticatePreviewPrincipal('kortix_sa_owner', SANDBOX_ID)).toBe('sa-owner');
  });
  test('rejects an invalid service-account token', async () => {
    expect(await authenticatePreviewPrincipal('kortix_sa_bad', SANDBOX_ID)).toBeNull();
  });
  test('rejects a valid SA token without sandbox access', async () => {
    allowedUsers.delete('sa-owner');
    expect(await authenticatePreviewPrincipal('kortix_sa_owner', SANDBOX_ID)).toBeNull();
  });

  // ── Kortix API token — ownership checked by account ────────────────────────
  test('accepts a kortix token for the owning account and returns the account id', async () => {
    expect(await authenticatePreviewPrincipal('kortix_owner', SANDBOX_ID)).toBe('acct-owner');
  });
  test('rejects a kortix token for another account', async () => {
    expect(await authenticatePreviewPrincipal('kortix_other', SANDBOX_ID)).toBeNull();
  });
  test('rejects an invalid kortix token', async () => {
    expect(await authenticatePreviewPrincipal('kortix_bad', SANDBOX_ID)).toBeNull();
  });

  // ── Supabase JWT ───────────────────────────────────────────────────────────
  test('accepts a JWT owner via local verify', async () => {
    expect(await authenticatePreviewPrincipal('jwt-owner', SANDBOX_ID)).toBe('user-owner');
  });
  test('rejects a JWT user without access', async () => {
    expect(await authenticatePreviewPrincipal('jwt-other', SANDBOX_ID)).toBeNull();
  });
  test('rejects a definitively invalid JWT without network fallback', async () => {
    expect(await authenticatePreviewPrincipal('jwt-garbage', SANDBOX_ID)).toBeNull();
  });
  test('falls back to the network verify path when JWKS is cold', async () => {
    mockSupabaseUser = { id: 'user-fallback-owner' };
    expect(await authenticatePreviewPrincipal('jwt-fallback', SANDBOX_ID)).toBe('user-fallback-owner');
  });
  test('rejects network-fallback user without access', async () => {
    mockSupabaseUser = { id: 'user-fallback-other' };
    expect(await authenticatePreviewPrincipal('jwt-fallback', SANDBOX_ID)).toBeNull();
  });
});

describe('extractPreviewToken', () => {
  const u = new URL('http://p3000-sbx.localhost:8008/x');

  test('prefers Authorization: Bearer', () => {
    const req = new Request(u, { headers: { Authorization: 'Bearer tok-bearer', 'X-Kortix-Token': 'tok-kx' } });
    expect(extractPreviewToken(req, new URL(req.url))).toBe('tok-bearer');
  });
  test('falls back to X-Kortix-Token', () => {
    const req = new Request(u, { headers: { 'X-Kortix-Token': 'tok-kx' } });
    expect(extractPreviewToken(req, new URL(req.url))).toBe('tok-kx');
  });
  test('falls back to ?token=', () => {
    const url = new URL('http://p3000-sbx.localhost:8008/x?token=tok-query');
    const req = new Request(url);
    expect(extractPreviewToken(req, url)).toBe('tok-query');
  });
  test('falls back to __preview_session cookie', () => {
    const req = new Request(u, { headers: { Cookie: 'a=1; __preview_session=tok-cookie; b=2' } });
    expect(extractPreviewToken(req, new URL(req.url))).toBe('tok-cookie');
  });
  test('returns null when no credential is present', () => {
    const req = new Request(u);
    expect(extractPreviewToken(req, new URL(req.url))).toBeNull();
  });
});

describe('preview subdomain auth cache key', () => {
  test('binds cached auth to client IP and user-agent, not only sandbox/port', () => {
    const a = new Request('http://p3000-sbx.localhost/x', {
      headers: { 'x-forwarded-for': '198.51.100.10', 'user-agent': 'browser-a' },
    });
    const b = new Request('http://p3000-sbx.localhost/x', {
      headers: { 'x-forwarded-for': '198.51.100.11', 'user-agent': 'browser-a' },
    });
    const c = new Request('http://p3000-sbx.localhost/x', {
      headers: { 'x-forwarded-for': '198.51.100.10', 'user-agent': 'browser-b' },
    });

    expect(previewSubdomainAuthCacheKeyForTest('sbx', 3000, a)).toBe('p3000-sbx|198.51.100.10|browser-a');
    expect(previewSubdomainAuthCacheKeyForTest('sbx', 3000, b)).not.toBe(
      previewSubdomainAuthCacheKeyForTest('sbx', 3000, a),
    );
    expect(previewSubdomainAuthCacheKeyForTest('sbx', 3000, c)).not.toBe(
      previewSubdomainAuthCacheKeyForTest('sbx', 3000, a),
    );
  });
});
