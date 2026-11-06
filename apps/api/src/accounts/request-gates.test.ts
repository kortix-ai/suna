/**
 * The session policy of a workspace applies on both route names:
 * `/v1/accounts/:workspaceId/<family>` and the canonical
 * `/v1/workspaces/:workspaceId/<family>`.
 *
 * Regression: the canonical alias re-mounts the catch-all middlewares on
 * `/:workspaceId/<family>`, so the session gate read the raw workspace id
 * (a project_id), found no account row and let a revoked session through.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000a1';
const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000b1';

const policyReads: string[] = [];

const realGate = await import('../iam/session-gate');
const realResolve = await import('../shared/resolve-account');
const realSurface = await import('../workspaces/surface');
mock.module('../iam/session-gate', () => ({
  ...realGate,
  evaluateSessionGate: () => 'revoked',
  loadPolicyAndActivity: async (accountId: string) => {
    policyReads.push(accountId);
    if (accountId !== ACCOUNT_ID) return null;
    return { maxLifetimeMinutes: null, idleTimeoutMinutes: 15, lastSeenAt: new Date(), revokedAt: new Date() };
  },
  markRevoked: async () => undefined,
  touchActivity: async () => ({ firstSight: false }),
}));
mock.module('../middleware/auth-audit', () => ({ auditSessionFirstSight: async () => undefined }));
mock.module('../middleware/sso-gate', () => ({
  accountSsoGate: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module('../shared/resolve-account', () => ({
  ...realResolve,
  resolveAccountId: async () => '00000000-0000-4000-8000-0000000000ff',
}));
mock.module('../workspaces/surface', () => ({
  ...realSurface,
  resolveWorkspace: async (id: string) =>
    id === WORKSPACE_ID || id === ACCOUNT_ID
      ? { workspaceId: WORKSPACE_ID, accountId: ACCOUNT_ID, splitPending: false }
      : null,
}));

const { accountRequestGates } = await import('./request-gates');
const { workspaceAccountFamiliesApp } = await import('../workspaces/index');

function buildApp(): OpenAPIHono {
  const router = new OpenAPIHono();
  router.use('/*', async (c, next) => {
    const writable = c as unknown as { set(k: string, v: unknown): void };
    writable.set('authType', 'supabase');
    writable.set('userId', '00000000-0000-4000-8000-0000000000c1');
    writable.set('sessionId', '00000000-0000-4000-8000-0000000000d1');
    writable.set('sessionIat', Math.floor(Date.now() / 1000));
    await next();
  });
  for (const gate of accountRequestGates()) router.use('/*', gate as never);
  router.get('/:workspaceId/members', (c) => c.json({ ran: true }));
  router.onError((err, c) => c.json({ error: (err as Error).message }, ((err as { status?: number }).status ?? 500) as 401));

  const app = new OpenAPIHono();
  app.route('/v1/accounts', router);
  app.route('/v1/workspaces', workspaceAccountFamiliesApp(router));
  return app;
}

beforeEach(() => {
  policyReads.length = 0;
});

describe('account request gates: the session policy on both route names', () => {
  test.each([
    `/v1/accounts/${ACCOUNT_ID}/members`,
    `/v1/accounts/${WORKSPACE_ID}/members`,
    `/v1/workspaces/${WORKSPACE_ID}/members`,
    `/v1/workspaces/${ACCOUNT_ID}/members`,
  ])('a revoked session gets 401 on GET %s', async (path) => {
    const res = await buildApp().request(path);
    expect(policyReads).toEqual([ACCOUNT_ID]);
    expect(res.status).toBe(401);
  });
});
