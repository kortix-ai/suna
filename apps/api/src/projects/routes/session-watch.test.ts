/**
 * GET/PUT /v1/projects/:projectId/sessions/:sessionId/watch (KRTX-1742): a
 * person who may see a session follows or mutes its notifications. The
 * access layer and the watcher store are stubbed; their SQL runs against real
 * Postgres in `notifications/session-watch.integration.test.ts`. Both routes
 * need the project's `notification_center` flag.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realWatchers from '../../notifications/watchers';
import * as realAccess from '../lib/access';
import * as realSessionAccess from '../lib/http-session-access';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const FLAG_ON = { experimental: { notification_center: true } };

let loaded: Record<string, unknown> | null = null;
let guard: Record<string, unknown> = { ok: true };
let guardNeeds: string[] = [];
let capabilityChecks: string[] = [];
let watchWrites: Array<{ projectId: string; sessionId: string; userId: string; watching: boolean }> = [];
let watchReads: Array<{ sessionId: string; userId: string; createdBy: string | null }> = [];

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => loaded,
  assertProjectCapability: async (_c: unknown, _u: string, _a: string, _p: string, action: string) => {
    capabilityChecks.push(action);
  },
}));
mock.module('../lib/http-session-access', () => ({
  ...realSessionAccess,
  guardSession: async (_c: unknown, _loaded: unknown, _sessionId: string, need: string) => {
    guardNeeds.push(need);
    return guard;
  },
}));
mock.module('../../notifications/watchers', () => ({
  ...realWatchers,
  setSessionWatch: async (projectId: string, sessionId: string, userId: string, watching: boolean) => {
    watchWrites.push({ projectId, sessionId, userId, watching });
  },
  isWatchingSession: async (sessionId: string, userId: string, createdBy: string | null) => {
    watchReads.push({ sessionId, userId, createdBy });
    return true;
  },
}));

const { projectsApp } = await import('../lib/app');
(await import('./session-watch')).registerSessionWatchRoutes();

type Caller = { authType: string; kind: string; sessionId?: string };
const browser: Caller = { authType: 'supabase', kind: 'jwt' };

function request(method: 'GET' | 'PUT', caller: Caller, body?: unknown, sessionId = SESSION_ID) {
  const app = new Hono<{ Variables: { userId: string; authType: string; sessionId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', caller.authType);
    if (caller.sessionId) c.set('sessionId', caller.sessionId);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  if (loaded) loaded = { ...loaded, actor: { credential: { kind: caller.kind } } };
  return app.request(`/v1/projects/${PROJECT_ID}/sessions/${sessionId}/watch`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  loaded = { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, metadata: FLAG_ON }, userId: USER_ID };
  guard = { ok: true, session: { row: { sessionId: SESSION_ID, createdBy: CREATOR } } };
  guardNeeds = [];
  capabilityChecks = [];
  watchWrites = [];
  watchReads = [];
});

describe('GET .../watch', () => {
  test('a person who may read the session gets their setting, decided with the session creator', async () => {
    const res = await request('GET', browser);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ watching: true });
    expect(watchReads).toEqual([{ sessionId: SESSION_ID, userId: USER_ID, createdBy: CREATOR }]);
    expect(guardNeeds).toEqual(['read']);
    expect(capabilityChecks).toEqual(['project.session.read']);
  });
});

describe('PUT .../watch', () => {
  test('watching=false mutes and watching=true follows, for the caller only', async () => {
    expect(await (await request('PUT', browser, { watching: false })).json()).toEqual({ watching: false });
    expect(await (await request('PUT', { authType: 'pat', kind: 'pat' }, { watching: true })).json()).toEqual({ watching: true });
    expect(watchWrites).toEqual([
      { projectId: PROJECT_ID, sessionId: SESSION_ID, userId: USER_ID, watching: false },
      { projectId: PROJECT_ID, sessionId: SESSION_ID, userId: USER_ID, watching: true },
    ]);
  });

  for (const body of [{}, { watching: 'no' }, undefined]) {
    test(`body ${JSON.stringify(body)} → 400 and nothing is written`, async () => {
      expect((await request('PUT', browser, body)).status).toBe(400);
      expect(watchWrites).toEqual([]);
    });
  }
});

describe('who may not', () => {
  const nonPeople: [string, Caller][] = [
    ['an agent session token', { authType: 'pat', kind: 'agent_session', sessionId: SESSION_ID }],
    ['a session-bound PAT', { authType: 'pat', kind: 'pat', sessionId: SESSION_ID }],
    ['an API key', { authType: 'apiKey', kind: 'sandbox' }],
    ['a service account', { authType: 'service_account', kind: 'service_account' }],
    ['an OAuth app', { authType: 'oauth', kind: 'jwt' }],
  ];
  for (const [name, caller] of nonPeople) {
    test(`${name} → 403 and nothing is read or written`, async () => {
      expect((await request('GET', caller)).status).toBe(403);
      expect((await request('PUT', caller, { watching: false })).status).toBe(403);
      expect(watchReads).toEqual([]);
      expect(watchWrites).toEqual([]);
    });
  }

  test('a session the caller cannot see, or a project they cannot read → 404', async () => {
    guard = { ok: false, status: 404, error: 'Not found' };
    expect((await request('GET', browser)).status).toBe(404);
    expect((await request('PUT', browser, { watching: true })).status).toBe(404);
    loaded = null;
    expect((await request('GET', browser)).status).toBe(404);
    expect(watchReads).toEqual([]);
    expect(watchWrites).toEqual([]);
  });

  for (const [name, metadata] of [
    ['the flag off', { experimental: { notification_center: false } }],
    ['no flag set (off by default)', {}],
  ] as const) {
    test(`a project with ${name} → 403 feature_disabled, before any access check, read or write`, async () => {
      loaded = { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, metadata }, userId: USER_ID };
      for (const res of [await request('GET', browser), await request('PUT', browser, { watching: false })]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'feature_disabled', feature: 'notification_center' });
      }
      expect(capabilityChecks).toEqual([]);
      expect(guardNeeds).toEqual([]);
      expect(watchReads).toEqual([]);
      expect(watchWrites).toEqual([]);
    });
  }

  test('a project the caller cannot read → 404, not the flag answer', async () => {
    loaded = null;
    expect((await request('PUT', browser, { watching: true })).status).toBe(404);
  });

  test('a non-uuid project id → 400', async () => {
    const app = new Hono();
    app.route('/v1/projects', projectsApp);
    expect((await app.request(`/v1/projects/not-a-uuid/sessions/${SESSION_ID}/watch`)).status).toBe(400);
  });
});
