import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { accountMembers, accountSecretResources, projectSessions, sessionProviderSecretPools } from '@kortix/db';

const accountId = '10000000-0000-4000-8000-000000000000';
const projectId = '11111111-1111-4111-8111-111111111111';
const otherProjectId = '12121212-1212-4121-8121-121212121212';
const sessionId = '22222222-2222-4222-8222-222222222222';
const managerId = '44444444-4444-4444-8444-444444444444';
const ownerId = '55555555-5555-4555-8555-555555555555';
const otherMemberId = '77777777-7777-4777-8777-777777777777';
/** A service account with a project role: authorized by the route, never an account member. */
const serviceAccountId = '88888888-8888-4888-8888-888888888888';
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
/** Principals with an `account_members` row. */
let members = new Set(users);
/** Who makes the request. */
let callerId = managerId;
/** The session model as stored by `PUT /sessions/:id/model`. */
let storedModel: string | null = null;
let writes = 0;

const projectKey = (n: number, over: Partial<Key> = {}): Key => ({
  secretId: keyId(n), projectId, providerId: 'anthropic', name: 'ANTHROPIC_API_KEY',
  accessMode: 'project', active: true, grants: [], ...over,
});

const dialect = new PgDialect();
const paramsOf = (condition: SQL | undefined) => (condition ? dialect.sqlToQuery(condition).params : []);
const app = new OpenAPIHono<any>();
app.use('*', async (c, next) => {
  if (!boundSession && callerId === serviceAccountId) {
    // A service-account bearer carries no session id (middleware/auth.ts).
    c.set('authType', 'service_account');
  } else {
    c.set('authType', boundSession ? 'pat' : 'supabase');
    c.set('sessionId', boundSession ?? 'browser-login');
  }
  await next();
});
mock.module('../lib/app', () => ({ projectsApp: app }));
mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: callerId,
    row: { accountId, metadata: {}, repoUrl: 'https://example.test/repo', defaultBranch: null, manifestPath: null },
  }),
  assertProjectCapability: async () => {},
  projectCapabilityAllowed: async () => true,
  loadVisibleSession: async (_loaded: unknown, target: string, caller: string | null, bound: string | null) => {
    // `PUT /model` passes the raw context session id: a browser login's is not a Kortix session.
    if ((caller && caller !== 'browser-login' && caller !== target) || (bound && bound !== target)) return null;
    return {
      row: { createdBy: ownerId, status: 'idle', metadata: {}, agentName: null },
      canManageLifecycle: canManage, ownerIsMachine,
    };
  },
}));
mock.module('../../feature-flags/gate', () => ({ requireFeatureFlag: () => null }));
const realRegistry = await import('../../feature-flags/registry');
mock.module('../../feature-flags/registry', () => ({ ...realRegistry, resolveFeatureFlag: () => true }));
const realEntitlements = await import('../../billing/services/entitlements');
mock.module('../../billing/services/entitlements', () => ({ ...realEntitlements, accountMayUseManagedModels: async () => true }));
// An Anthropic model serves only through a selection that holds a key.
const realDefaultModel = await import('../../llm-gateway/resolution/default-model');
mock.module('../../llm-gateway/resolution/default-model', () => ({
  ...realDefaultModel,
  isModelServableForAccount: async (input: { providerSecretPools?: Record<string, string[]> }) =>
    Boolean((input.providerSecretPools ?? Object.fromEntries(pools)).anthropic?.length),
}));
const realEnvSync = await import('../lib/sandbox-env-sync');
mock.module('../lib/sandbox-env-sync', () => ({ ...realEnvSync, pushSessionModelToSandbox: async () => ({ ok: true }) }));
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
 * named provider (and key name, when the query names one) among the named ids
 * (every key, when the query names none),
 * each with the grant of the one user the grant join names.
 */
function keyRows(where: unknown[], grantUser: string | null) {
  const names = where.filter((p): p is string => typeof p === 'string' && /^[A-Z][A-Z0-9_]*$/.test(p));
  const ids = where.filter((p): p is string => typeof p === 'string' && p.startsWith(keyId(0).slice(0, 24)));
  return keys
    .filter((key) => key.active && where.includes(key.providerId) && (!ids.length || ids.includes(key.secretId)))
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
    /** The principal an `account_members` join requires; undefined when the query has no such join. */
    let memberJoin: string | undefined;
    const query: any = {
      $dynamic: () => query,
      innerJoin: (joined: unknown, condition: SQL) => {
        if (joined === accountMembers) memberJoin = paramsOf(condition).find((p) => p !== accountId) as string;
        return query;
      },
      leftJoin: (_joined: unknown, condition: SQL) => {
        grantUser = (paramsOf(condition).find((p) => users.includes(p as string)) as string | undefined) ?? null;
        return query;
      },
      where: (condition: SQL) => {
        const params = paramsOf(condition);
        if (table === accountMembers) {
          rows = params.some((p) => members.has(p as string)) ? [{ userId: params.find((p) => members.has(p as string)) }] : [];
          return query;
        }
        rows = table === accountSecretResources
          ? (memberJoin !== undefined && !members.has(memberJoin) ? [] : keyRows(params, grantUser))
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
  insert: (table: unknown) => ({ values: (row: { providerId: string; secretIds: string[] }) => ({
    onConflictDoUpdate: async () => { writes++; pools.set(row.providerId, row.secretIds); },
    onConflictDoNothing: () => ({ returning: async () => {
      if (table !== sessionProviderSecretPools) throw new Error('unexpected insert');
      if (pools.has(row.providerId)) return [];
      writes++;
      pools.set(row.providerId, row.secretIds);
      return [{ sessionId }];
    } }),
  }) }),
  update: (table: unknown) => ({ set: (values: { metadata: { opencode_model: string } }) => ({ where: async () => {
    if (table !== projectSessions) throw new Error('unexpected update');
    storedModel = values.metadata.opencode_model;
  } }) }),
  delete: () => ({ where: async (condition: SQL) => {
    writes++;
    for (const p of paramsOf(condition)) pools.delete(p as string);
  } }),
} }));
await import('./provider-secret-pools');
await import('./session-scope');
const { MAX_KEYS_PER_PROVIDER } = await import('../../secrets/provider-key-selection');

const putModel = (model: string) => app.request(`/${projectId}/sessions/${sessionId}/model`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opencode_model: model }),
});

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
  members = new Set(users);
  callerId = managerId;
  storedModel = null;
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
  const owner = await put('anthropic', [keyId(1)]);
  expect(owner.status).toBe(403);
  expect(await owner.json()).toEqual({
    error: 'The session owner can no longer read this project, so the session cannot use provider secrets',
    code: 'SESSION_OWNER_NO_PROJECT_ACCESS',
  });
  readers = new Set(users);
  readers.delete(managerId);
  const caller = await put('anthropic', [keyId(1)]);
  expect(caller.status).toBe(403);
  expect(await caller.json()).toEqual({ error: 'Secret unavailable or not granted' });
  expect(writes).toBe(0);
});

test('a shared session whose owner cannot read the project names that cause, not the key`s sharing', async () => {
  // Every key is shared with the whole project, so "shared session" is not
  // why the selection is refused.
  keys = [projectKey(1)];
  readers.delete(ownerId);
  sessionPersonal = null;
  const response = await put('anthropic', [keyId(1)]);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: 'The session owner can no longer read this project, so the session cannot use provider secrets',
    code: 'SESSION_OWNER_NO_PROJECT_ACCESS',
  });
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

// A service-account bearer's `userId` is the service account's id, and a
// service account has no `account_members` row. The gateway serves a session's
// selection as the session owner, not as the caller, so a service account with
// a project role may select keys shared with the whole project, as before.
test('a service-account caller selects keys shared with the whole project for a human-owned session', async () => {
  callerId = serviceAccountId;
  keys = [projectKey(1), projectKey(2, { projectId: null })];
  const response = await put('anthropic', [keyId(1), keyId(2)]);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ provider_id: 'anthropic', configured: true, secret_ids: [keyId(1), keyId(2)] });
  sessionPersonal = null;
  expect((await put('anthropic', [keyId(1)])).status).toBe(200);
  expect(pools.get('anthropic')).toEqual([keyId(1)]);
});

test('a service-account caller cannot select a key granted to one member', async () => {
  callerId = serviceAccountId;
  keys = [projectKey(1, { accessMode: 'members', grants: [ownerId] })];
  const response = await put('anthropic', [keyId(1)]);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Secret unavailable or not granted' });
  expect(writes).toBe(0);
});

test('a member-granted key counts only for a caller with an account membership', async () => {
  keys = [projectKey(1, { accessMode: 'members', grants: [managerId, ownerId] })];
  members.delete(managerId);
  const response = await put('anthropic', [keyId(1)]);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Secret unavailable or not granted' });
  expect(writes).toBe(0);
});

test('the session check keeps the member gate: an owner with no account membership gets no key', async () => {
  // The gateway joins `account_members` on the owner when it serves the keys.
  callerId = serviceAccountId;
  keys = [projectKey(1)];
  members.delete(ownerId);
  const response = await put('anthropic', [keyId(1)]);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'The session owner cannot use every selected secret' });
  expect(writes).toBe(0);
});

describe('PUT /sessions/:id/model to a model only pooled keys reach', () => {
  const model = 'anthropic/claude-sonnet-4-5';

  test('a service-account caller stores the project keys and the model', async () => {
    callerId = serviceAccountId;
    keys = [projectKey(1), projectKey(2)];
    const response = await putModel(model);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.opencode_model).toBe(storedModel!);
    expect(storedModel).toContain(model);
    expect(pools.get('anthropic')).toEqual([keyId(1), keyId(2)]);
  });

  test('a member caller stores the same selection', async () => {
    keys = [projectKey(1), projectKey(2)];
    expect((await putModel(model)).status).toBe(200);
    expect(pools.get('anthropic')).toEqual([keyId(1), keyId(2)]);
  });

  test('refused, and nothing stored, when the only key is granted to one member', async () => {
    callerId = serviceAccountId;
    keys = [projectKey(1, { accessMode: 'members', grants: [ownerId] })];
    const response = await putModel(model);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_SESSION_MODEL' });
    expect(pools.size).toBe(0);
    expect(storedModel).toBeNull();
  });
});
