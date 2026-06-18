/**
 * Unit tests for the tunnel auth tiers (apps/api/src/tunnel/routes/auth.ts).
 *
 * Locks the regression that killed the cloud agent: the sandbox authenticates
 * with an `apiKey` (KORTIX_TOKEN), so it MUST be able to READ connections + RPC
 * (getTunnelReadContext), while tunnel MANAGEMENT stays user-credential-only
 * (getTunnelOwnerContext → requireUserCredential rejects apiKey).
 */
import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import {
  requireUserCredential,
  getTunnelReadContext,
  getTunnelOwnerContext,
} from '../tunnel/routes/auth';

/** Minimal stand-in for a Hono context: only `c.get(key)` is used here. */
function fakeCtx(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] } as any;
}

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('requireUserCredential', () => {
  test('rejects apiKey auth with 403', () => {
    let status = 0;
    try {
      requireUserCredential(fakeCtx({ authType: 'apiKey' }));
    } catch (err) {
      if (err instanceof HTTPException) status = err.status;
    }
    expect(status).toBe(403);
  });

  for (const authType of ['pat', 'supabase', 'jwt', 'service_account']) {
    test(`allows ${authType}`, () => {
      expect(() => requireUserCredential(fakeCtx({ authType }))).not.toThrow();
    });
  }
});

describe('getTunnelReadContext — the agent (apiKey) path', () => {
  test('apiKey with an accountId resolves WITHOUT requiring a user credential', async () => {
    const ctx = await getTunnelReadContext(
      fakeCtx({ authType: 'apiKey', accountId: ACCOUNT }),
    );
    expect(ctx.accountId).toBe(ACCOUNT);
    expect(ctx.userId).toBeUndefined();
    expect(ctx.ownerClause).toBeDefined();
  });

  test('a team user (userId !== accountId) still resolves', async () => {
    const ctx = await getTunnelReadContext(
      fakeCtx({ authType: 'supabase', userId: USER, accountId: ACCOUNT }),
    );
    expect(ctx.accountId).toBe(ACCOUNT);
    expect(ctx.userId).toBe(USER);
    expect(ctx.ownerClause).toBeDefined();
  });

  test('no account and no user → 401', async () => {
    let status = 0;
    try {
      await getTunnelReadContext(fakeCtx({ authType: 'apiKey' }));
    } catch (err) {
      if (err instanceof HTTPException) status = err.status;
    }
    expect(status).toBe(401);
  });
});

describe('getTunnelOwnerContext — management stays user-only', () => {
  test('apiKey is rejected with 403 (cannot manage)', async () => {
    let status = 0;
    try {
      await getTunnelOwnerContext(fakeCtx({ authType: 'apiKey', accountId: ACCOUNT }));
    } catch (err) {
      if (err instanceof HTTPException) status = err.status;
    }
    expect(status).toBe(403);
  });

  test('a user credential is accepted', async () => {
    const ctx = await getTunnelOwnerContext(
      fakeCtx({ authType: 'supabase', userId: USER, accountId: ACCOUNT }),
    );
    expect(ctx.accountId).toBe(ACCOUNT);
    expect(ctx.ownerClause).toBeDefined();
  });
});
