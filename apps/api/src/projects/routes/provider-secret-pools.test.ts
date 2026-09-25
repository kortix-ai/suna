import { beforeEach, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { PgDialect } from 'drizzle-orm/pg-core';
import { accountSecretResources } from '@kortix/db';

const projectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const secretId = '33333333-3333-4333-8333-333333333333';
const managerId = '44444444-4444-4444-8444-444444444444';
const ownerId = '55555555-5555-4555-8555-555555555555';
const base = `/${projectId}/sessions/${sessionId}/provider-secret-pools`;
let boundSession: string | null = null;
let ownerHasGrant = false;
let ownerIsMachine = false;
let canManage = true;
let writes = 0;
const dialect = new PgDialect();
const app = new OpenAPIHono<any>();
app.use('*', async (c, next) => {
  c.set('authType', boundSession ? 'pat' : 'supabase');
  c.set('sessionId', boundSession ?? 'browser-login');
  await next();
});
mock.module('../lib/app', () => ({ projectsApp: app }));
mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: managerId,
    row: { accountId: projectId, metadata: {}, repoUrl: 'https://example.test/repo' },
  }),
  assertProjectCapability: async () => {},
  loadVisibleSession: async (_loaded: unknown, target: string, caller: string | null, bound: string | null) => {
    if ((caller && caller !== target) || (bound && bound !== target)) return null;
    return { row: { createdBy: ownerId }, canManageLifecycle: canManage, ownerIsMachine };
  },
}));
mock.module('../../feature-flags/gate', () => ({ requireFeatureFlag: () => null }));
mock.module('../../llm-gateway/enablement', () => ({ projectLlmGatewayEnabled: () => true }));
mock.module('../../llm-gateway/models/provider-registry', () => ({
  resolveCatalogUpstream: () => ({ envVar: 'ANTHROPIC_API_KEY' }),
}));
mock.module('../lib/secret-grant', () => ({ resolveSessionAgentGrant: async () => ({ env: ['ANTHROPIC_API_KEY'] }) }));
mock.module('../agents', () => ({ DEFAULT_AGENT_SENTINEL: 'default' }));
/** The session's personal user as the gateway resolves it: its owner in private, null when shared. */
let sessionPersonal: string | null = ownerId;
mock.module('../lib/personal-resources', () => ({ resolveSessionPersonalOwner: async () => sessionPersonal }));
mock.module('../../shared/db', () => ({ db: {
  select: () => ({ from: (table: unknown) => {
    let rows: unknown[] = [];
    let selectingOwner = false;
    const query: any = {
      innerJoin: () => query,
      leftJoin: (_joined: unknown, condition: any) => {
        selectingOwner = dialect.sqlToQuery(condition).params.includes(ownerId);
        return query;
      },
      where: () => {
        rows = table === accountSecretResources
          ? [{ id: secretId, projectId: null, accessMode: 'members', grantUserId: selectingOwner ? (ownerHasGrant ? ownerId : null) : managerId }]
          : [{ provider_id: 'anthropic', configured: true, secret_ids: [], ids: [] }];
        return query;
      },
      limit: () => Promise.resolve(rows),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  } }),
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { writes++; } }) }),
  delete: () => ({ where: async () => { writes++; } }),
} }));
await import('./provider-secret-pools');

beforeEach(() => {
  boundSession = null;
  sessionPersonal = ownerId;
  ownerHasGrant = false;
  ownerIsMachine = false;
  canManage = true;
  writes = 0;
});

test('lists configured empty pools even when no key remains', async () => {
  const response = await app.request(base);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.pools).toEqual([{ provider_id: 'anthropic', configured: true, secret_ids: [] }]);
  expect(body.can_edit).toBe(true);
});

test('a session-bound credential cannot read or reset a sibling pool', async () => {
  boundSession = '66666666-6666-4666-8666-666666666666';
  for (const path of [base, `${base}/anthropic`]) {
    expect((await app.request(path)).status).toBe(404);
  }
  expect((await app.request(`${base}/anthropic`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret_ids: null }),
  })).status).toBe(404);
  expect(writes).toBe(0);
});

test('a manager cannot select a key the session owner cannot use', async () => {
  const put = () => app.request(`${base}/anthropic`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret_ids: [secretId] }),
  });
  expect((await put()).status).toBe(403);
  expect(writes).toBe(0);
  ownerHasGrant = true;
  expect((await put()).status).toBe(200);
  expect(writes).toBe(1);
});

test('a machine-owned session cannot select personal resources', async () => {
  ownerIsMachine = true;
  ownerHasGrant = true;
  expect((await app.request(`${base}/anthropic`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret_ids: [secretId] }),
  })).status).toBe(403);
  expect(writes).toBe(0);
});

test('a shared session never selects a key granted to one member, even its owner', async () => {
  // The gateway serves a shared session with no personal user (spec
  // 2026-09-22 §2.3), so a member-granted key would never be used.
  sessionPersonal = null;
  ownerHasGrant = true;
  const response = await app.request(`${base}/anthropic`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret_ids: [secretId] }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'SHARED_SESSION_PERSONAL_KEY' });
  expect(writes).toBe(0);
});
