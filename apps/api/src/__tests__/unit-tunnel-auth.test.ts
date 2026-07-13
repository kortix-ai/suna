/**
 * Unit tests for the tunnel auth tiers (apps/api/src/tunnel/routes/auth.ts).
 *
 * Locks the regression that killed the cloud agent: the sandbox authenticates
 * with an `apiKey` (KORTIX_TOKEN), so it MUST be able to READ connections + RPC
 * (getTunnelReadContext), while tunnel MANAGEMENT stays user-credential-only
 * (getTunnelOwnerContext -> requireUserCredential rejects non-human tokens).
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  requireUserCredential,
  getTunnelReadContext,
  getTunnelOwnerContext,
} from '../tunnel/routes/auth';
import { createConnectionsRouter } from '../tunnel/routes/connections';

/** Minimal stand-in for a Hono context: only `c.get(key)` is used here. */
function fakeCtx(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] } as any;
}

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('requireUserCredential', () => {
  for (const authType of ['pat', 'supabase']) {
    test(`allows ${authType}`, () => {
      expect(() => requireUserCredential(fakeCtx({ authType }))).not.toThrow();
    });
  }

  for (const authType of ['apiKey', 'service_account', 'jwt', 'unknown', undefined]) {
    test(`rejects ${authType ?? 'missing'} auth with 403`, () => {
      let status = 0;
      try {
        requireUserCredential(fakeCtx({ authType }));
      } catch (err) {
        if (err instanceof HTTPException) status = err.status;
      }
      expect(status).toBe(403);
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

  test('service_account is rejected with 403 (cannot manage)', async () => {
    let status = 0;
    try {
      await getTunnelOwnerContext(fakeCtx({ authType: 'service_account', accountId: ACCOUNT }));
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

describe('tunnel management routes', () => {
  test('service accounts cannot create tunnel connections over HTTP', async () => {
    const app = new Hono();
    app.use('/connections', async (c, next) => {
      c.set('authType' as never, 'service_account' as never);
      c.set('accountId' as never, ACCOUNT as never);
      c.set('userId' as never, 'service-account-id' as never);
      await next();
    });
    app.route('/connections', createConnectionsRouter());

    const res = await app.request('/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SA-owned tunnel',
        capabilities: ['filesystem'],
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('User credentials are required');
  });
});
