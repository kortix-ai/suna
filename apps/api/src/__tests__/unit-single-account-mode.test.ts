/**
 * Self-host single-account mode: KORTIX_SINGLE_ACCOUNT_MODE=true must block
 * POST /v1/accounts (creating additional accounts) with 403, while every
 * other accounts route stays untouched. This exercises the REAL config
 * module (not a mock) — the env var is set before any app module is
 * imported — so the test also proves the schema/config wiring in
 * apps/api/src/config.ts, not just the route's own `if` check.
 *
 * Deliberately minimal mocking: the single-account-mode gate in
 * registerAccountRoutes() runs before any DB access, so this only needs the
 * auth middleware mocked (no session_id → the session-gate + resolveAccountId
 * paths both no-op) and a stub db module (never actually queried by this
 * route in single-account mode).
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const OWNER_ID = '00000000-0000-4000-a000-000000000001';

process.env.KORTIX_SINGLE_ACCOUNT_MODE = 'true';

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', OWNER_ID);
    c.set('userEmail', 'owner@example.test');
    c.set('authType', 'supabase');
    // No sessionId set on purpose — the session-gate + resolveAccountId
    // paths in accounts/index.ts both no-op without one.
    await next();
  },
}));

mock.module('../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    insert: () => {
      throw new Error('db.insert should never be reached in single-account mode');
    },
    select: () => {
      throw new Error('db.select should never be reached for this route in this test');
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

describe('single-account mode (KORTIX_SINGLE_ACCOUNT_MODE=true)', () => {
  test('blocks POST /v1/accounts with 403', async () => {
    const res = await createApp().request('/v1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second Team' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('single-account mode');
  });

  test('config.KORTIX_SINGLE_ACCOUNT_MODE reflects the env var', async () => {
    const { config } = await import('../config');
    expect(config.KORTIX_SINGLE_ACCOUNT_MODE).toBe(true);
  });
});
