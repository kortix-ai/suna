/**
 * PUT /v1/projects/:projectId/sessions/:sessionId/presence — who keeps the
 * session's computer awake (KRTX-1729).
 *
 * Any viewer's visible tab used to extend the box by 30 minutes per ping, on
 * the account's bill. A presence lease still routes pushes for every viewer;
 * only a caller who may start the session extends the deadline, and by the
 * idle grace.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';
import * as realDeadline from '../sandbox-deadline';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const TAB_ID = '66666666-6666-4666-8666-666666666666';

let mayStartSession = true;
let leaseWrites = 0;
let leaseDeletes = 0;
let extensions: Array<{ target: unknown; grantMs: number }> = [];

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: '44444444-4444-4444-8444-444444444444' },
    userId: USER_ID,
    actor: { credential: { kind: 'jwt' } },
  }),
  assertProjectCapability: async () => {},
  projectCapabilityAllowed: async (_c: unknown, _u: string, _a: string, _p: string, action: string) =>
    action === 'project.session.start' ? mayStartSession : true,
  loadVisibleSession: async () => ({ row: { metadata: {} } }),
  sessionIsTombstoned: () => false,
}));

mock.module('../../shared/db', () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => {
          leaseWrites += 1;
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        leaseDeletes += 1;
      },
    }),
  },
}));

mock.module('../sandbox-deadline', () => ({
  ...realDeadline,
  extendSandboxDeadline: async (target: unknown, grantMs: number) => {
    extensions.push({ target, grantMs });
  },
  // KRTX-1729: presence extends through the capped statement, by the idle grace.
  extendSandboxDeadlineForPresence: async (target: unknown) => {
    extensions.push({ target, grantMs: realDeadline.idleGraceMs() });
  },
}));

const { projectsApp } = await import('../lib/app');
(await import('./session-presence')).registerSessionPresenceRoutes();

function put(body: unknown) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app.request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/presence`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mayStartSession = true;
  leaseWrites = 0;
  leaseDeletes = 0;
  extensions = [];
});

describe('PUT .../presence', () => {
  test('a person who may start the session keeps the computer awake by the idle grace', async () => {
    const res = await put({ tab_id: TAB_ID, active: true });
    expect(res.status).toBe(200);
    expect(leaseWrites).toBe(1);
    expect(extensions).toEqual([{ target: { sessionId: SESSION_ID }, grantMs: realDeadline.idleGraceMs() }]);
  });

  test('a viewer who may not start the session holds the lease and extends nothing', async () => {
    mayStartSession = false;
    const res = await put({ tab_id: TAB_ID, active: true });
    expect(res.status).toBe(200);
    expect(leaseWrites).toBe(1);
    expect(extensions).toEqual([]);
  });

  test('active=false drops the lease and extends nothing', async () => {
    const res = await put({ tab_id: TAB_ID, active: false });
    expect(res.status).toBe(200);
    expect(leaseDeletes).toBe(1);
    expect(extensions).toEqual([]);
  });
});
