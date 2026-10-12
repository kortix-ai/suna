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
import * as realInboxRead from '../../notifications/inbox-read';
import * as realAccess from '../lib/access';
import * as realDeadline from '../sandbox-deadline';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const TAB_ID = '66666666-6666-4666-8666-666666666666';

let mayStartSession = true;
let leaseWrites = 0;
let leaseDeletes = 0;
let leaseValues: Array<Record<string, unknown>> = [];
let leaseUpdates: Array<Record<string, unknown>> = [];
let sessionsMarkedRead: Array<{ userId: string; sessionId: string }> = [];
let extensions: Array<{ target: unknown; grantMs: number }> = [];
let projectMetadata: Record<string, unknown> = {};

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: '44444444-4444-4444-8444-444444444444', metadata: projectMetadata },
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
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (conflict: { set: Record<string, unknown> }) => {
          leaseWrites += 1;
          leaseValues.push(values);
          leaseUpdates.push(conflict.set);
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

// KRTX-1742: an active tab marks the caller's notifications of the session read.
mock.module('../../notifications/inbox-read', () => ({
  ...realInboxRead,
  markSessionNotificationsRead: async (userId: string, sessionId: string) => {
    sessionsMarkedRead.push({ userId, sessionId });
    return 0;
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
  leaseValues = [];
  leaseUpdates = [];
  sessionsMarkedRead = [];
  extensions = [];
  projectMetadata = { experimental: { notification_center: true } };
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
    expect(sessionsMarkedRead).toEqual([]);
  });

  // KRTX-1742: only a tab that raises its own OS notification holds back the phone.
  test('alerts defaults to false and is written on insert and on refresh', async () => {
    expect((await put({ tab_id: TAB_ID, active: true })).status).toBe(200);
    expect((await put({ tab_id: TAB_ID, active: true, alerts: true })).status).toBe(200);
    expect(leaseValues.map((v) => v.alerts)).toEqual([false, true]);
    expect(leaseUpdates.map((v) => v.alerts)).toEqual([false, true]);
  });

  test('an active tab marks the caller\'s notifications of this session read', async () => {
    expect((await put({ tab_id: TAB_ID, active: true })).status).toBe(200);
    expect(sessionsMarkedRead).toEqual([{ userId: USER_ID, sessionId: SESSION_ID }]);
  });

  test('with the notification_center flag off, an active tab holds its lease and marks nothing read', async () => {
    for (const metadata of [{}, { experimental: { notification_center: false } }]) {
      projectMetadata = metadata;
      expect((await put({ tab_id: TAB_ID, active: true })).status).toBe(200);
    }
    expect(leaseWrites).toBe(2);
    expect(extensions).toHaveLength(2);
    expect(sessionsMarkedRead).toEqual([]);
  });

  test('a missing body or a non-boolean alerts → 400 and nothing is written', async () => {
    expect((await put({ tab_id: TAB_ID, active: true, alerts: 'yes' })).status).toBe(400);
    expect((await put({ active: true })).status).toBe(400);
    expect(leaseWrites).toBe(0);
    expect(sessionsMarkedRead).toEqual([]);
  });
});
