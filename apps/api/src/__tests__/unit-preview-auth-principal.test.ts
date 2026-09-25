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
import * as realPreviewOwnership from '../shared/preview-ownership';

const SANDBOX_ID = 'sandbox-xyz';
let allowedAccounts = new Set<string>(['acct-owner']);
let allowedUsers = new Set<string>(['user-owner', 'sa-owner', 'pat-user-owner', 'user-fallback-owner']);
let mockSupabaseUser: { id: string } | null = null;
let sandboxProjects = new Map<string, string>();

const actualCrypto = await import('../shared/crypto');
mock.module('../shared/crypto', () => ({
  ...actualCrypto,
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));

// mock.module REPLACES the module wholesale — any export omitted here becomes a
// SyntaxError for whatever else in the import graph needs it, which takes the
// WHOLE FILE down to 0 tests rather than failing one case. So the unused exports
// are stubbed too, and they throw: if the graph ever really calls one, it should
// be loud rather than silently returning undefined.
const unmocked = (name: string) => () => {
  throw new Error(`${name} is not stubbed in this suite`);
};
mock.module('../repositories/api-keys', () => ({
  validateSecretKey: async (t: string) => {
    if (t === 'kortix_owner') return { isValid: true, accountId: 'acct-owner' };
    if (t === 'kortix_other') return { isValid: true, accountId: 'acct-other' };
    return { isValid: false, error: 'invalid' };
  },
  createApiKey: unmocked('api-keys.createApiKey'),
  listApiKeys: unmocked('api-keys.listApiKeys'),
  revokeApiKey: unmocked('api-keys.revokeApiKey'),
  deleteApiKey: unmocked('api-keys.deleteApiKey'),
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (t: string) => {
    if (t === 'kortix_pat_owner') return { isValid: true, userId: 'pat-user-owner' };
    if (t === 'kortix_pat_project_a') {
      return { isValid: true, userId: 'pat-user-owner', projectId: 'project-a', sessionId: 'session-a' };
    }
    if (t === 'kortix_pat_other') return { isValid: true, userId: 'pat-user-other' };
    return { isValid: false, error: 'invalid' };
  },
  createAccountToken: unmocked('account-tokens.createAccountToken'),
  listAccountTokens: unmocked('account-tokens.listAccountTokens'),
  revokeAccountToken: unmocked('account-tokens.revokeAccountToken'),
  revokeAllAccountTokensForUser: unmocked('account-tokens.revokeAllAccountTokensForUser'),
}));

mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async (t: string) => {
    if (t === 'kortix_sa_owner') {
      return { isValid: true, serviceAccountId: 'sa-owner', accountId: 'acct-owner' };
    }
    return { isValid: false, error: 'invalid' };
  },
  listServiceAccounts: unmocked('service-accounts.listServiceAccounts'),
  getServiceAccount: unmocked('service-accounts.getServiceAccount'),
  createServiceAccount: unmocked('service-accounts.createServiceAccount'),
  listAgentServiceAccounts: unmocked('service-accounts.listAgentServiceAccounts'),
  ensureAgentServiceAccount: unmocked('service-accounts.ensureAgentServiceAccount'),
  disableServiceAccount: unmocked('service-accounts.disableServiceAccount'),
  deleteServiceAccount: unmocked('service-accounts.deleteServiceAccount'),
}));

mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async (t: string) => {
    if (t === 'jwt-owner') return { ok: true, userId: 'user-owner' };
    if (t === 'jwt-other') return { ok: true, userId: 'user-other' };
    if (t === 'jwt-fallback') return { ok: false, reason: 'no-keys' };
    if (t === 'jwt-unknown-kid') return { ok: false, reason: 'no-key-for-kid' };
    // Prod on 2026-09-15: JWKS publishes an ES256 key while GoTrue still signs
    // access tokens with the legacy HS256 secret.
    if (t === 'jwt-hs256') return { ok: false, reason: 'unsupported-alg:HS256' };
    if (t === 'jwt-expired') return { ok: false, reason: 'expired' };
    if (t === 'jwt-bad-signature') return { ok: false, reason: 'bad-signature' };
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

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
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
  resolveSandboxProjectId: async (sandboxId: string) => sandboxProjects.get(sandboxId) ?? null,
  clearPreviewOwnershipCache: () => {},
  invalidatePreviewCacheForUser: () => {},
}));

const { authenticatePreviewPrincipalDetailed, extractPreviewToken } = await import(
  '../sandbox-proxy/preview-auth'
);

/** The id of the principal the credential proves on this sandbox, or null. */
const principalId = async (token: string | null, sandboxId = SANDBOX_ID) =>
  (await authenticatePreviewPrincipalDetailed(token, sandboxId))?.userId ?? null;

beforeEach(() => {
  allowedAccounts = new Set(['acct-owner']);
  allowedUsers = new Set(['user-owner', 'sa-owner', 'pat-user-owner', 'user-fallback-owner']);
  mockSupabaseUser = null;
  sandboxProjects = new Map([
    [SANDBOX_ID, 'project-a'],
    ['sandbox-of-project-b', 'project-b'],
  ]);
});

describe('authenticatePreviewPrincipalDetailed — which credentials prove a principal', () => {
  test('returns null for empty token', async () => {
    expect(await principalId(null)).toBeNull();
    expect(await principalId('')).toBeNull();
  });

  // ── PAT (kortix_pat_) — was rejected by the subdomain edge before ──────────
  test('accepts a PAT for an owner and returns the user id', async () => {
    expect(await principalId('kortix_pat_owner')).toBe('pat-user-owner');
  });
  test('rejects a valid PAT that lacks sandbox access', async () => {
    expect(await principalId('kortix_pat_other')).toBeNull();
  });
  test('accepts a project-scoped PAT only for a sandbox of its own project', async () => {
    expect(await principalId('kortix_pat_project_a')).toBe('pat-user-owner');
    expect(await principalId('kortix_pat_project_a', 'sandbox-of-project-b')).toBeNull();
    expect(await principalId('kortix_pat_project_a', 'sandbox-unknown')).toBeNull();
  });

  test('rejects an invalid PAT', async () => {
    expect(await principalId('kortix_pat_bad')).toBeNull();
  });

  // ── Service-account (kortix_sa_) — was rejected by subdomain AND WS ────────
  test('accepts a service-account token for an owner and returns the SA id', async () => {
    expect(await principalId('kortix_sa_owner')).toBe('sa-owner');
  });
  test('rejects an invalid service-account token', async () => {
    expect(await principalId('kortix_sa_bad')).toBeNull();
  });
  test('rejects a valid SA token without sandbox access', async () => {
    allowedUsers.delete('sa-owner');
    expect(await principalId('kortix_sa_owner')).toBeNull();
  });

  // ── Kortix API token — ownership checked by account ────────────────────────
  test('accepts a kortix token for the owning account and returns the account id', async () => {
    expect(await principalId('kortix_owner')).toBe('acct-owner');
  });
  test('rejects a kortix token for another account', async () => {
    expect(await principalId('kortix_other')).toBeNull();
  });
  test('rejects an invalid kortix token', async () => {
    expect(await principalId('kortix_bad')).toBeNull();
  });

  // ── Supabase JWT ───────────────────────────────────────────────────────────
  test('accepts a JWT owner via local verify', async () => {
    expect(await principalId('jwt-owner')).toBe('user-owner');
  });
  test('rejects a JWT user without access', async () => {
    expect(await principalId('jwt-other')).toBeNull();
  });
  // Which verify failures are inconclusive is the shared predicate's
  // (unit-jwt-alg-fallback.test.ts); this proves preview-auth routes on it.
  test('falls back to the network verify path for a legacy HS256 token when JWKS holds an ES256 key', async () => {
    mockSupabaseUser = { id: 'user-fallback-owner' };
    expect(await principalId('jwt-hs256')).toBe('user-fallback-owner');
  });
  test('rejects an expired or badly signed JWT without asking the network', async () => {
    // The network would say yes; a real local verdict must win anyway.
    mockSupabaseUser = { id: 'user-fallback-owner' };
    expect(await principalId('jwt-expired')).toBeNull();
    expect(await principalId('jwt-bad-signature')).toBeNull();
  });
  test('rejects network-fallback user without access', async () => {
    mockSupabaseUser = { id: 'user-fallback-other' };
    expect(await principalId('jwt-fallback')).toBeNull();
  });
});

// The same extraction priority as combinedAuth: Bearer, then X-Kortix-Token,
// then ?token=, then the __preview_session cookie.
describe('extractPreviewToken', () => {
  test.each([
    [
      'Authorization: Bearer beats every other source',
      'http://p3000-sbx.localhost:8008/x?token=tok-query',
      {
        Authorization: 'Bearer tok-bearer',
        'X-Kortix-Token': 'tok-kx',
        Cookie: '__preview_session=tok-cookie',
      },
      'tok-bearer',
    ],
    [
      'X-Kortix-Token beats the query and the cookie',
      'http://p3000-sbx.localhost:8008/x?token=tok-query',
      { 'X-Kortix-Token': 'tok-kx', Cookie: '__preview_session=tok-cookie' },
      'tok-kx',
    ],
    [
      '?token= beats the cookie',
      'http://p3000-sbx.localhost:8008/x?token=tok-query',
      { Cookie: '__preview_session=tok-cookie' },
      'tok-query',
    ],
    [
      'the __preview_session cookie, among others',
      'http://p3000-sbx.localhost:8008/x',
      { Cookie: 'a=1; __preview_session=tok-cookie; b=2' },
      'tok-cookie',
    ],
    ['nothing', 'http://p3000-sbx.localhost:8008/x', {}, null],
  ])('%s', (_label, href, headers, token) => {
    const url = new URL(href);
    expect(extractPreviewToken(new Request(url, { headers }), url)).toBe(token);
  });
});

describe('authenticatePreviewPrincipalDetailed — session binding', () => {
  test('a sandbox PAT reports the session it is bound to', async () => {
    // This is what separates one KaaB end-user from another: every session
    // shares the wrapper's userId, so only the token's own sessionId can.
    const p = await authenticatePreviewPrincipalDetailed('kortix_pat_project_a', SANDBOX_ID);
    expect(p?.userId).toBe('pat-user-owner');
    expect(p?.sessionId).toBe('session-a');
  });

  test('non-PAT credentials report no session binding', async () => {
    expect((await authenticatePreviewPrincipalDetailed('kortix_sa_owner', SANDBOX_ID))?.sessionId).toBeNull();
    expect((await authenticatePreviewPrincipalDetailed('kortix_owner', SANDBOX_ID))?.sessionId).toBeNull();
    expect((await authenticatePreviewPrincipalDetailed('jwt-owner', SANDBOX_ID))?.sessionId).toBeNull();
  });

});

describe('a proven preview credential names its caller in the request audit', () => {
  // Preview subdomains and the PTY / preview WebSockets are dispatched before
  // Hono: no auth middleware names their caller. This validator does, the
  // moment a token is proven — BEFORE the sandbox-ownership check, so a caller
  // refused on someone else's sandbox is still attributed.
  const { runWithContext } = require('../lib/request-context');
  const { attachInboundAuditScope } = require('../shared/audit-scope');

  async function principalAfter(token: string) {
    return runWithContext('GET', '/', async () => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: 'GET' });
      const result = await authenticatePreviewPrincipalDetailed(token, SANDBOX_ID);
      return { result, principal: scope.principal };
    });
  }

  // A session-bound token is the sandbox's own agent, whichever user minted
  // it, and the audit names the session it acts for.
  test('a sandbox PAT is the agent of its session, never the person who minted it', async () => {
    const { principal } = await principalAfter('kortix_pat_project_a');
    expect(principal).toMatchObject({
      actorType: 'agent',
      actorUserId: null,
      authMethod: { kind: 'account_token', principal_id: 'pat-user-owner', session_id: 'session-a' },
    });
  });

  test('a Supabase session is the human user', async () => {
    const { result, principal } = await principalAfter('jwt-owner');
    expect(result).toMatchObject({ userId: 'user-owner', principalKind: 'user' });
    expect(principal).toMatchObject({ actorType: 'human', actorUserId: 'user-owner', authMethod: { kind: 'jwt' } });
  });

  test('a user refused on another sandbox is still named', async () => {
    const { result, principal } = await principalAfter('jwt-other');
    expect(result).toBeNull();
    expect(principal).toMatchObject({ actorType: 'human', actorUserId: 'user-other' });
  });

  test('a service account is not written as a user', async () => {
    const { result, principal } = await principalAfter('kortix_sa_owner');
    expect(result).toMatchObject({ userId: 'sa-owner', principalKind: 'service_account' });
    expect(principal).toMatchObject({
      actorType: 'service_account',
      actorUserId: null,
      authMethod: { kind: 'service_account', service_account_id: 'sa-owner' },
    });
  });

  test('an account API key is system; its account id is never a user id', async () => {
    const { result, principal } = await principalAfter('kortix_owner');
    expect(result).toMatchObject({ userId: 'acct-owner', principalKind: 'account' });
    expect(principal).toMatchObject({ actorType: 'system', actorUserId: null });
  });

  test('an invalid token binds nothing', async () => {
    const { result, principal } = await principalAfter('kortix_pat_forged');
    expect(result).toBeNull();
    expect(principal).toEqual({});
  });
});
