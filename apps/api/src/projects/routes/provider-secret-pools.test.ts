import { beforeEach, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { accountSecretResources } from '@kortix/db';

const accountId = '10000000-0000-4000-8000-000000000000';
const projectId = '11111111-1111-4111-8111-111111111111';
const otherProjectId = '12121212-1212-4121-8121-121212121212';
const sessionId = '22222222-2222-4222-8222-222222222222';
const managerId = '44444444-4444-4444-8444-444444444444';
const ownerId = '55555555-5555-4555-8555-555555555555';
const otherMemberId = '77777777-7777-4777-8777-777777777777';
const users = [managerId, ownerId, otherMemberId];
const keyId = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const base = `/${projectId}/sessions/${sessionId}/provider-secret-pools`;

interface Key {
  secretId: string; projectId: string | null; providerId: string; name: string;
  accessMode: 'project' | 'members'; active: boolean; grants: string[];
}
/** The account's pooled keys, as `account_secret_resources` + `account_secret_grants`. */
let keys: Key[] = [];
/** The session's stored selections by provider. */
let pools = new Map<string, string[]>();
let boundSession: string | null = null;
let ownerIsMachine = false;
let canManage = true;
/** The session's personal user as the gateway resolves it: its owner in private, null when shared. */
let sessionPersonal: string | null = ownerId;
let agentEnv = ['ANTHROPIC_API_KEY', 'CODEX_AUTH_JSON'];
/** Users IAM lets read the project. */
let readers = new Set(users);
let writes = 0;

const projectKey = (n: number, over: Partial<Key> = {}): Key => ({
  secretId: keyId(n), projectId, providerId: 'anthropic', name: 'ANTHROPIC_API_KEY',
  accessMode: 'project', active: true, grants: [], ...over,
});

const dialect = new PgDialect();
const paramsOf = (condition: SQL | undefined) => (condition ? dialect.sqlToQuery(condition).params : []);
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
    row: { accountId, metadata: {}, repoUrl: 'https://example.test/repo' },
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
  resolveCatalogUpstream: (providerId: string) => (providerId === 'anthropic' ? { envVar: 'ANTHROPIC_API_KEY' } : null),
}));
mock.module('../lib/secret-grant', () => ({ resolveSessionAgentGrant: async () => ({ env: agentEnv }) }));
mock.module('../agents', () => ({ DEFAULT_AGENT_SENTINEL: 'default' }));
mock.module('../lib/personal-resources', () => ({ resolveSessionPersonalOwner: async () => sessionPersonal }));
const realAuthorize = await import('../../iam/authorize');
mock.module('../../iam/authorize', () => ({
  ...realAuthorize,
  authorize: async (actor: { userId: string }) => ({ allowed: readers.has(actor.userId) }),
}));

/**
 * A query over the pooled keys as PostgreSQL answers it: active keys of the
 * named provider (and key name, when the query names one) among the named ids,
 * each with the grant of the one user the grant join names.
 */
function keyRows(where: unknown[], grantUser: string | null) {
  const names = where.filter((p): p is string => typeof p === 'string' && /^[A-Z][A-Z0-9_]*$/.test(p));
  return keys
    .filter((key) => key.active && where.includes(key.providerId) && where.includes(key.secretId))
    .filter((key) => !names.length || names.includes(key.name))
    .map((key) => ({
      id: key.secretId, secretId: key.secretId, providerId: key.providerId, name: key.name, label: key.secretId,
      projectId: key.projectId, accessMode: key.accessMode,
      grantUserId: grantUser && key.grants.includes(grantUser) ? grantUser : null,
    }));
}

mock.module('../../shared/db', () => ({ db: {
  select: () => ({ from: (table: unknown) => {
    let rows: unknown[] = [];
    let grantUser: string | null = null;
    const query: any = {
      innerJoin: () => query,
      leftJoin: (_joined: unknown, condition: SQL) => {
        grantUser = (paramsOf(condition).find((p) => users.includes(p as string)) as string | undefined) ?? null;
        return query;
      },
      where: (condition: SQL) => {
        const params = paramsOf(condition);
        rows = table === accountSecretResources
          ? keyRows(params, grantUser)
          : [...pools].filter(([providerId]) => !params.some((p) => p !== sessionId) || params.includes(providerId))
            .map(([providerId, ids]) => ({ provider_id: providerId, secret_ids: ids, ids }));
        return query;
      },
      orderBy: () => query,
      limit: () => Promise.resolve(rows),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  } }),
  insert: () => ({ values: (row: { providerId: string; secretIds: string[] }) => ({
    onConflictDoUpdate: async () => { writes++; pools.set(row.providerId, row.secretIds); },
  }) }),
  delete: () => ({ where: async (condition: SQL) => {
    writes++;
    for (const p of paramsOf(condition)) pools.delete(p as string);
  } }),
} }));
await import('./provider-secret-pools');
const { MAX_KEYS_PER_PROVIDER } = await import('../../secrets/provider-key-selection');

const put = (providerId: string, secretIds: string[] | null) => app.request(`${base}/${providerId}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret_ids: secretIds }),
});

beforeEach(() => {
  keys = [];
  pools = new Map();
  boundSession = null;
  sessionPersonal = ownerId;
  ownerIsMachine = false;
  canManage = true;
  agentEnv = ['ANTHROPIC_API_KEY', 'CODEX_AUTH_JSON'];
  readers = new Set(users);
  writes = 0;
});

test('lists configured empty pools even when no key remains', async () => {
  pools.set('anthropic', []);
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
  expect((await put('anthropic', null)).status).toBe(404);
  expect(writes).toBe(0);
});

test('a stored selection reads back, and a null selection clears it', async () => {
  keys = [projectKey(1), projectKey(2)];
  const response = await put('anthropic', [keyId(1), keyId(2)]);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ provider_id: 'anthropic', configured: true, secret_ids: [keyId(1), keyId(2)] });
  expect(await (await app.request(`${base}/anthropic`)).json())
    .toEqual({ provider_id: 'anthropic', configured: true, secret_ids: [keyId(1), keyId(2)] });
  expect((await put('anthropic', null)).status).toBe(200);
  expect(await (await app.request(`${base}/anthropic`)).json())
    .toEqual({ provider_id: 'anthropic', configured: false, secret_ids: [] });
});

test('an unknown provider is refused', async () => {
  const response = await put('nobody', [keyId(1)]);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Unknown provider' });
  expect(writes).toBe(0);
});

test('at most ten distinct keys per provider', async () => {
  expect(MAX_KEYS_PER_PROVIDER).toBe(10);
  keys = Array.from({ length: MAX_KEYS_PER_PROVIDER + 1 }, (_, i) => projectKey(i));
  const tooMany = keys.map((key) => key.secretId);
  expect((await put('anthropic', tooMany)).status).toBe(400);
  const duplicate = await put('anthropic', [keyId(1), keyId(1)]);
  expect(duplicate.status).toBe(400);
  expect(await duplicate.json()).toEqual({ error: 'Invalid or duplicate secret id' });
  expect(writes).toBe(0);
  expect((await put('anthropic', tooMany.slice(0, MAX_KEYS_PER_PROVIDER))).status).toBe(200);
});

test('a key shared with the whole project serves private and shared sessions', async () => {
  keys = [projectKey(1), projectKey(2, { projectId: null })];
  expect((await put('anthropic', [keyId(1), keyId(2)])).status).toBe(200);
  sessionPersonal = null;
  expect((await put('anthropic', [keyId(1), keyId(2)])).status).toBe(200);
  expect(writes).toBe(2);
});

test('a key granted to one member serves only that member`s private session', async () => {
  keys = [projectKey(1, { accessMode: 'members', grants: [managerId, ownerId] })];
  expect((await put('anthropic', [keyId(1)])).status).toBe(200);
  sessionPersonal = otherMemberId;
  const otherOwner = await put('anthropic', [keyId(1)]);
  expect(otherOwner.status).toBe(403);
  expect(await otherOwner.json()).toEqual({ error: 'The session owner cannot use every selected secret' });
  expect(writes).toBe(1);
});

test('a manager cannot select a key the session owner cannot use', async () => {
  keys = [projectKey(1, { accessMode: 'members', grants: [managerId] })];
  expect((await put('anthropic', [keyId(1)])).status).toBe(403);
  expect(writes).toBe(0);
  keys[0]!.grants.push(ownerId);
  expect((await put('anthropic', [keyId(1)])).status).toBe(200);
  expect(writes).toBe(1);
});

test('the caller cannot select a key granted only to the session owner', async () => {
  keys = [projectKey(1, { accessMode: 'members', grants: [ownerId] })];
  const response = await put('anthropic', [keyId(1)]);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Secret unavailable or not granted' });
});

test('a key of another project, an inactive key, or a missing key is refused', async () => {
  keys = [projectKey(1, { projectId: otherProjectId }), projectKey(2, { active: false })];
  for (const id of [keyId(1), keyId(2), keyId(3)]) {
    const response = await put('anthropic', [id]);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Secret unavailable or not granted' });
  }
  expect(writes).toBe(0);
});

test('a key stored under another name for the provider is refused', async () => {
  keys = [projectKey(1, { name: 'OTHER_KEY' })];
  expect((await put('anthropic', [keyId(1)])).status).toBe(403);
});

test('a selection is refused when the member it is checked for cannot read the project', async () => {
  // The gateway serves pooled keys only to a member who may read the project
  // (resolveSessionProviderSecrets); the selection is checked the same way.
  keys = [projectKey(1)];
  readers.delete(ownerId);
  expect((await put('anthropic', [keyId(1)])).status).toBe(403);
  readers = new Set(users);
  readers.delete(managerId);
  expect((await put('anthropic', [keyId(1)])).status).toBe(403);
  expect(writes).toBe(0);
});

test('ChatGPT connections are the codex provider`s CODEX_AUTH_JSON keys', async () => {
  keys = [projectKey(1, { providerId: 'codex', name: 'CODEX_AUTH_JSON' })];
  expect((await put('codex', [keyId(1)])).status).toBe(200);
  agentEnv = ['ANTHROPIC_API_KEY'];
  const response = await put('codex', [keyId(1)]);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Agent cannot use this provider secret' });
});

test('a machine-owned session cannot select personal resources', async () => {
  ownerIsMachine = true;
  keys = [projectKey(1)];
  expect((await put('anthropic', [keyId(1)])).status).toBe(403);
  expect(writes).toBe(0);
});

test('a shared session never selects a key granted to one member, even its owner', async () => {
  // The gateway serves a shared session with no personal user (spec
  // 2026-09-22 §2.3), so a member-granted key would never be used.
  sessionPersonal = null;
  keys = [projectKey(1, { accessMode: 'members', grants: [managerId, ownerId] })];
  const response = await put('anthropic', [keyId(1)]);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'SHARED_SESSION_PERSONAL_KEY' });
  expect(writes).toBe(0);
});
