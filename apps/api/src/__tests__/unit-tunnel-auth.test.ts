/**
 * Unit tests for the tunnel auth tiers (apps/api/src/tunnel/routes/auth.ts).
 *
 * Raw tunnel HTTP access is an account-level privileged surface. Project and
 * session credentials must use a Computer Tunnel connector profile so its machine
 * allowlist, grants, and tool policies cannot be bypassed.
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
import { effectiveRegisteredCapabilities } from '../tunnel';
import { tunnelRelay } from '../tunnel/core/relay';
import { heartbeatManager } from '../tunnel/core/heartbeat';

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

describe('getTunnelReadContext — privileged raw tunnel access', () => {
  test('an account API key without a sandbox identity can read', async () => {
    const ctx = await getTunnelReadContext(fakeCtx({ authType: 'apiKey', accountId: ACCOUNT }));
    expect(ctx.accountId).toBe(ACCOUNT);
    expect(ctx.userId).toBeUndefined();
    expect(ctx.ownerClause).toBeDefined();
  });

  for (const values of [
    { authType: 'apiKey', accountId: ACCOUNT, sandboxId: 'sandbox-1' },
    {
      authType: 'pat',
      accountId: ACCOUNT,
      userId: USER,
      tokenProjectId: 'project-1',
    },
    { authType: 'service_account', accountId: ACCOUNT, userId: 'service-1' },
  ]) {
    test(`rejects ${values.authType} project/service credentials`, async () => {
      let status = 0;
      try {
        await getTunnelReadContext(fakeCtx(values));
      } catch (err) {
        if (err instanceof HTTPException) status = err.status;
      }
      expect(status).toBe(403);
    });
  }

  test('a personal user resolves their own fleet', async () => {
    const ctx = await getTunnelReadContext(
      fakeCtx({ authType: 'supabase', userId: USER, accountId: USER }),
    );
    expect(ctx.accountId).toBe(USER);
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
      fakeCtx({ authType: 'supabase', userId: USER, accountId: USER }),
    );
    expect(ctx.accountId).toBe(USER);
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

describe('tunnel agent capability registration', () => {
  test('uses the live handler list within the browser-approved ceiling', () => {
    expect(
      effectiveRegisteredCapabilities(
        ['filesystem', 'desktop'],
        ['filesystem', 'shell', 'desktop'],
      ),
    ).toEqual(['filesystem', 'desktop']);
  });

  test('rejects a live capability escalation above browser approval', () => {
    expect(
      effectiveRegisteredCapabilities(['filesystem', 'shell', 'desktop'], ['filesystem']),
    ).toEqual(['filesystem']);
  });

  test('rejects malformed and duplicate live registrations', () => {
    expect(
      effectiveRegisteredCapabilities(['filesystem', 'filesystem'], ['filesystem']),
    ).toBeNull();
    expect(effectiveRegisteredCapabilities(['filesystem', 'camera'], ['filesystem'])).toBeNull();
  });
});

describe('tunnel heartbeat wiring', () => {
  test('records each signed agent pong in the heartbeat manager', () => {
    const originalRecordPong = heartbeatManager.recordPong;
    const recorded: string[] = [];
    heartbeatManager.recordPong = (tunnelId: string) => {
      recorded.push(tunnelId);
    };

    try {
      tunnelRelay.emitEvent('message:pong', {
        tunnelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        params: {},
      });
      expect(recorded).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    } finally {
      heartbeatManager.recordPong = originalRecordPong;
    }
  });
});
