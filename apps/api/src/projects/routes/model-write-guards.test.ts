/**
 * KRTX-4437: the four model write routes (PUT /model-access, PUT
 * /model-enablement, PUT and DELETE /model-defaults) share one guard — project
 * visible at floor 'read' (else 404), then project.model.write (else 403), both
 * before the body is read — and the two /model-defaults routes share one
 * scope → preference-key mapping. Pinned through the real handlers so the
 * inlined guard copies can collapse into `loadModelDefaultsWriter` unchanged.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

const ACCOUNT_ID = 'account-test';
const USER_ID = 'user-test';
const PROJECT_ID = 'project-test';

let loaded: { userId: string; row: { accountId: string; metadata: Record<string, never> } } | null;
let denied: boolean;
let calls: string[];
let upserts: Array<Record<string, unknown>>;
let deletes: Array<Record<string, unknown>>;

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (_c: unknown, _projectId: string, action: string) => {
    calls.push(`load:${action}`);
    return loaded;
  },
  assertProjectCapability: async (_c: unknown, _u: string, _a: string, _p: string, action: string) => {
    calls.push(`capability:${action}`);
    if (denied) throw new HTTPException(403, { message: 'denied' });
  },
}));
mock.module('../../repositories/model-preferences', () => ({
  getAccountModelDefaults: async () => ({ account: null, projects: {}, agents: {} }),
  upsertAccountModelPreference: async (input: Record<string, unknown>) => {
    upserts.push(input);
  },
  deleteAccountModelPreference: async (input: Record<string, unknown>) => {
    deletes.push(input);
  },
}));
const projectAccess = await import('../../repositories/project-model-access');
mock.module('../../repositories/project-model-access', () => ({
  ...projectAccess,
  changeProjectModelAccess: async () => ({ conflict: false, policy: { disabledProviders: [], disabledModels: [] } }),
}));
const routingPolicies = await import('../../repositories/project-routing-policies');
mock.module('../../repositories/project-routing-policies', () => ({
  ...routingPolicies,
  setProjectModelOverrides: async () => {},
}));
mock.module('../../billing/services/entitlements', () => ({ accountMayUseManagedModels: async () => true }));
mock.module('../../llm-gateway/resolution/default-model', () => ({
  resolveEffectiveModel: async () => ({ model: null, source: 'platform' }),
  invalidateAccountModelDefaults: () => {},
  isModelServableForAccount: async () => true,
}));
const { projectsApp } = await import('../lib/app');
(await import('./models')).registerModelsRoutes();

beforeEach(() => {
  loaded = { userId: USER_ID, row: { accountId: ACCOUNT_ID, metadata: {} } };
  denied = false;
  calls = [];
  upserts = [];
  deletes = [];
});

const send = (method: string, path: string, body?: unknown) =>
  projectsApp.request(`/${PROJECT_ID}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

const writes: Array<[string, string, string, unknown]> = [
  ['PUT /model-access', 'PUT', '/model-access', { target: 'model', id: 'm', enabled: false }],
  ['PUT /model-enablement', 'PUT', '/model-enablement', { modelOverrides: { m: false } }],
  ['PUT /model-defaults', 'PUT', '/model-defaults', { scope: 'account', model: 'm' }],
  ['DELETE /model-defaults', 'DELETE', '/model-defaults?scope=account', undefined],
];

describe('the model write guard', () => {
  for (const [name, method, path, body] of writes) {
    describe(name, () => {
      test("404s an unknown project at floor 'read' before any capability check", async () => {
        loaded = null;
        const response = await send(method, path, body);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Not found' });
        expect(calls).toEqual(['load:read']);
      });

      test('403s without project.model.write; nothing is written', async () => {
        denied = true;
        const response = await send(method, path, body);
        expect(response.status).toBe(403);
        expect(calls).toEqual(['load:read', 'capability:project.model.write']);
        expect(upserts).toEqual([]);
        expect(deletes).toEqual([]);
      });

      test('a writer passes the guard in order', async () => {
        await send(method, path, body);
        expect(calls).toEqual(['load:read', 'capability:project.model.write']);
      });
    });
  }
});

describe('the /model-defaults scope → preference key mapping', () => {
  const missingAgent = { error: 'agentName is required for scope=agent', code: 'agent_name_required' };

  test('PUT without an agentName for scope=agent → 400, nothing written', async () => {
    const response = await send('PUT', '/model-defaults', { scope: 'agent', model: 'm' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(missingAgent);
    expect(upserts).toEqual([]);
  });

  test('DELETE without an agentName for scope=agent → 400, nothing deleted', async () => {
    const response = await send('DELETE', '/model-defaults?scope=agent');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(missingAgent);
    expect(deletes).toEqual([]);
  });

  test('PUT scope=account stores no key and no project', async () => {
    expect((await send('PUT', '/model-defaults', { scope: 'account', model: 'm' })).status).toBe(200);
    expect(upserts).toEqual([
      { accountId: ACCOUNT_ID, scope: 'account', scopeKey: undefined, projectId: undefined, model: 'm', updatedBy: USER_ID },
    ]);
  });

  test('PUT scope=project keys on the project id', async () => {
    expect((await send('PUT', '/model-defaults', { scope: 'project', model: 'm' })).status).toBe(200);
    expect(upserts).toEqual([
      { accountId: ACCOUNT_ID, scope: 'project', scopeKey: PROJECT_ID, projectId: undefined, model: 'm', updatedBy: USER_ID },
    ]);
  });

  const cleared: Array<[string, string, Record<string, unknown>]> = [
    ['account', 'scope=account', { scope: 'account', scopeKey: undefined, projectId: undefined }],
    ['project', 'scope=project', { scope: 'project', scopeKey: PROJECT_ID, projectId: undefined }],
    ['agent', 'scope=agent&agentName=reviewer', { scope: 'agent', scopeKey: 'reviewer', projectId: PROJECT_ID }],
  ];
  for (const [name, query, key] of cleared) {
    test(`DELETE scope=${name} clears ${JSON.stringify(key)}`, async () => {
      const response = await send('DELETE', `/model-defaults?${query}`);
      expect(response.status).toBe(200);
      expect(deletes).toEqual([{ accountId: ACCOUNT_ID, ...key }]);
    });
  }
});
