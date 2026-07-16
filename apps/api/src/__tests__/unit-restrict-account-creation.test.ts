/**
 * Self-host account-creation restriction: KORTIX_RESTRICT_ACCOUNT_CREATION=true
 * must block POST /v1/accounts (creating an ADDITIONAL/org account) with 403
 * for everyone except a platform admin — while GET /v1/accounts (which
 * bootstraps the caller's own personal account on first login via
 * bootstrapPersonalAccount) stays completely unaffected.
 *
 * This is deliberately narrower than the removed KORTIX_SINGLE_ACCOUNT_MODE:
 * it only gates the "create a brand-new organization" path, never the
 * personal-account bootstrap every user needs to land in the app.
 *
 * Exercises the REAL config module (env var set before any app module is
 * imported) so the test also proves the schema/config wiring in
 * apps/api/src/config.ts, not just the route's own `if` check.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const ADMIN_ID = '00000000-0000-4000-a000-000000000001';
const MEMBER_ID = '00000000-0000-4000-a000-000000000002';

process.env.KORTIX_RESTRICT_ACCOUNT_CREATION = 'true';

let callerId = MEMBER_ID;
let isPlatformAdminMock = false;

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', callerId);
    c.set('userEmail', 'caller@example.test');
    c.set('authType', 'supabase');
    // No sessionId set on purpose — the session-gate + resolveAccountId
    // paths in accounts/index.ts both no-op without one.
    await next();
  },
}));

mock.module('../shared/platform-roles', () => ({
  isPlatformAdmin: async () => isPlatformAdminMock,
  getPlatformRole: async () => (isPlatformAdminMock ? 'admin' : 'user'),
}));

let insertedAccount: { name: string } | null = null;

mock.module('../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    insert: (table: any) => ({
      values: (vals: any) => {
        // accounts insert: { name } → chained .returning(); accountMembers
        // insert: { userId, accountId, ... } → no .returning() call site.
        if ('name' in (vals ?? {})) insertedAccount = vals;
        return {
          returning: async () => [
            {
              accountId: 'new-account-id',
              name: vals.name,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        };
      },
    }),
    select: () => {
      throw new Error('db.select should not be reached by these tests');
    },
  },
}));

let accountsRouter: any;

beforeAll(async () => {
  ({ accountsRouter } = await import('../accounts/index'));
});

function createApp() {
  const app = new Hono();
  app.route('/v1/accounts', accountsRouter);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

describe('account-creation restriction (KORTIX_RESTRICT_ACCOUNT_CREATION=true)', () => {
  beforeEach(() => {
    callerId = MEMBER_ID;
    isPlatformAdminMock = false;
    insertedAccount = null;
  });

  test('config.KORTIX_RESTRICT_ACCOUNT_CREATION reflects the env var', async () => {
    const { config } = await import('../config');
    expect(config.KORTIX_RESTRICT_ACCOUNT_CREATION).toBe(true);
  });

  test('blocks POST /v1/accounts for a non-admin with 403 + account_creation_restricted', async () => {
    isPlatformAdminMock = false;
    const res = await createApp().request('/v1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second Team' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('account_creation_restricted');
    expect(insertedAccount).toBeNull();
  });

  test('allows POST /v1/accounts for a platform admin', async () => {
    callerId = ADMIN_ID;
    isPlatformAdminMock = true;
    const res = await createApp().request('/v1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Admin-created Team' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('Admin-created Team');
    expect(insertedAccount).toEqual({ name: 'Admin-created Team' });
  });
});
