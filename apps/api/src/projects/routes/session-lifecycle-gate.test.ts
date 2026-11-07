/**
 * KRTX-4437: restart, recover, stop, delete and restore each guard the session
 * with the same owner/manager gate and differ only in their refusal wording,
 * their capability and what they do with a tombstoned session. Pinned per
 * route through the real handlers (access and lifecycle services mocked at
 * their module seams) so the five copies can become one helper unchanged.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';
import * as realLifecycle from '../session-lifecycle';
import { sessionRestoreUntil } from '../session-log-purge';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const DELETED_AT = '2026-11-06T00:00:00.000Z';

let loadedProject: { row: { accountId: string; projectId: string }; userId: string } | null;
let visibleSession: { row: Record<string, unknown>; canManageLifecycle: boolean } | null;
let calls: string[];

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (_c: unknown, _projectId: string, action: string) => {
    calls.push(`load:${action}`);
    return loadedProject;
  },
  assertProjectCapability: async (_c: unknown, _u: string, _a: string, _p: string, action: string) => {
    calls.push(`capability:${action}`);
  },
  loadVisibleSession: async () => {
    calls.push('visible');
    return visibleSession;
  },
}));
mock.module('../session-lifecycle', () => ({
  ...realLifecycle,
  restartSession: async () => {
    calls.push('service:restart');
    return { status: 409, body: { error: 'x' } };
  },
  stopSession: async () => {
    calls.push('service:stop');
    return { status: 409, body: { error: 'x' } };
  },
  deleteSession: async () => {
    calls.push('service:delete');
    return { ok: true, restore_until: '2026-12-06T00:00:00.000Z' };
  },
  restoreSession: async () => {
    calls.push('service:restore');
    return { ok: true };
  },
}));
mock.module('../session-lifecycle/recover-lost-session', () => ({
  recoverLostSession: async () => {
    calls.push('service:recover');
    return { ok: true };
  },
}));
mock.module('../subagent-notice', () => ({ stoppedSubagentNotice: async () => null }));

const { projectsApp } = await import('../lib/app');
(await import('./session-runtime')).registerSessionRuntimeRoutes();
(await import('./project-sessions')).registerProjectSessionsRoutes();

function request(method: string, suffix: string, sessionId = SESSION_ID) {
  const application = new Hono<{ Variables: { userId: string; authType: string } }>();
  application.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  application.route('/v1/projects', projectsApp);
  return application.request(`/v1/projects/${PROJECT_ID}/sessions/${sessionId}${suffix}`, { method });
}

beforeEach(() => {
  calls = [];
  loadedProject = { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID }, userId: USER_ID };
  visibleSession = { row: { sessionId: SESSION_ID, metadata: {} }, canManageLifecycle: true };
});

const tombstoned = () => ({
  row: { sessionId: SESSION_ID, metadata: { deletedAt: DELETED_AT } },
  canManageLifecycle: true,
});

// [name, method, suffix, 403 text, capability asserted before the session load, service]
const routes: Array<[string, string, string, string, string | null, string]> = [
  ['restart', 'POST', '/restart', 'Only the session owner or an account owner/admin can restart this session', null, 'restart'],
  ['recover', 'POST', '/recover', 'Only the session owner or an account owner/admin can continue this session', null, 'recover'],
  ['stop', 'POST', '/stop', 'Only the session owner or an account owner/admin can stop this session', 'project.session.stop', 'stop'],
  ['delete', 'DELETE', '', 'Only the session owner or a workspace manager can stop this session', null, 'delete'],
  ['restore', 'POST', '/restore', 'Only the session owner or a workspace manager can restore this session', null, 'restore'],
];

describe('the owner/manager session gate of restart, recover, stop, delete and restore', () => {
  for (const [name, method, suffix, refusal, capability, service] of routes) {
    describe(name, () => {
      test('400s a non-UUID session id before any load', async () => {
        const response = await request(method, suffix, 'not-a-uuid');
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid session id' });
        expect(calls).toEqual([]);
      });

      test("404s an unknown project at floor 'session', loading nothing else", async () => {
        loadedProject = null;
        const response = await request(method, suffix);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Not found' });
        expect(calls).toEqual(['load:session']);
      });

      test('404s a session that is not visible; the service never runs', async () => {
        visibleSession = null;
        const response = await request(method, suffix);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Not found' });
        expect(calls).toEqual(['load:session', ...(capability ? [`capability:${capability}`] : []), 'visible']);
      });

      test('403s a member who is neither the owner nor a manager, with this route\'s wording', async () => {
        visibleSession = { row: { sessionId: SESSION_ID, metadata: {} }, canManageLifecycle: false };
        const response = await request(method, suffix);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: refusal });
        expect(calls).toEqual(['load:session', ...(capability ? [`capability:${capability}`] : []), 'visible']);
      });

      test('an owner or manager reaches the service', async () => {
        await request(method, suffix);
        expect(calls).toEqual([
          'load:session',
          ...(capability ? [`capability:${capability}`] : []),
          'visible',
          `service:${service}`,
        ]);
      });
    });
  }

  // The tombstone rule differs per route: restart and recover refuse a deleted
  // session; stop, delete (idempotent) and restore (its whole point) do not.
  for (const [name, method, suffix] of routes.slice(0, 2)) {
    test(`${name}: 404s a tombstoned session before the manager check`, async () => {
      visibleSession = { ...tombstoned(), canManageLifecycle: false };
      const response = await request(method, suffix);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found' });
      expect(calls.some((entry) => entry.startsWith('service:'))).toBe(false);
    });
  }

  test('stop: a tombstoned session still reaches the stop service', async () => {
    visibleSession = tombstoned();
    await request('POST', '/stop');
    expect(calls).toContain('service:stop');
  });

  test('delete: a tombstoned session answers the first stamp and deletes nothing', async () => {
    visibleSession = tombstoned();
    const response = await request('DELETE', '');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      restore_until: sessionRestoreUntil(DELETED_AT)?.toISOString(),
    });
    expect(calls).not.toContain('service:delete');
  });

  test('delete: a tombstoned session is still refused to a non-manager', async () => {
    visibleSession = { ...tombstoned(), canManageLifecycle: false };
    expect((await request('DELETE', '')).status).toBe(403);
  });

  test('restore: a tombstoned session reaches the restore service', async () => {
    visibleSession = tombstoned();
    await request('POST', '/restore');
    expect(calls).toContain('service:restore');
  });
});
