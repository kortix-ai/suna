import { beforeEach, expect, mock, test } from 'bun:test';

let managed = false;
let configuredDefault: string | null = null;
let resolvedModel: string | null = null;
const changes: Array<{ defaultModel?: string }> = [];
mock.module('../../billing/services/entitlements', () => ({ accountMayUseManagedModels: async () => managed }));
mock.module('../../repositories/model-preferences', () => ({
  getAccountModelDefaults: async () => ({ account: configuredDefault, projects: {}, agents: {} }),
  deleteAccountModelPreference: async () => {},
  upsertAccountModelPreference: async () => {},
}));
mock.module('../../llm-gateway/resolution/default-model', () => ({
  resolveEffectiveModel: async () => ({ model: resolvedModel, source: 'platform' }),
  invalidateAccountModelDefaults: () => {},
  isModelServableForAccount: async () => true,
}));
mock.module('../../llm-gateway/models/served-managed-models', () => ({
  platformDefaultModelId: () => 'deepseek-v4.1-flash', SERVED_MANAGED_MODELS: [],
}));
const projectAccess = await import('../../repositories/project-model-access');
mock.module('../../repositories/project-model-access', () => ({
  ...projectAccess,
  changeProjectModelAccess: async (input: { defaultModel?: string }) => {
    changes.push(input);
    return { conflict: false, policy: { disabledProviders: [], disabledModels: [] } };
  },
}));
mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({ userId: 'user-test', row: { accountId: 'account-test', metadata: {} } }),
  assertProjectCapability: async () => {},
}));
mock.module('../../llm-gateway/enablement', () => ({ projectLlmGatewayEnabled: () => true }));
const { projectsApp } = await import('../lib/app');
(await import('./models')).registerModelsRoutes();

beforeEach(() => { managed = false; configuredDefault = null; resolvedModel = null; changes.length = 0; });

async function access(method: 'GET' | 'PUT') {
  const response = await projectsApp.request('/project-test/model-access', {
    method,
    ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'model', id: 'deepseek-v4.1-flash', enabled: false }) } : {}),
  });
  expect(response.status).toBe(200);
  return response.json();
}

for (const method of ['GET', 'PUT'] as const) {
  test(`${method} does not advertise a paid default to an unconnected free account`, async () => {
    expect((await access(method)).defaultModel).toBeUndefined();
    if (method === 'PUT') expect(changes[0]?.defaultModel).toBeUndefined();
  });
  test(`${method} retains the managed platform default for a paid account`, async () => {
    managed = true;
    expect((await access(method)).defaultModel).toBe('deepseek-v4.1-flash');
  });
  test(`${method} uses the connected model resolved for a free account`, async () => {
    resolvedModel = 'codex/gpt-6';
    expect((await access(method)).defaultModel).toBe('codex/gpt-6');
    if (method === 'PUT') expect(changes[0]?.defaultModel).toBe('codex/gpt-6');
  });
}

test('PUT protects a configured preference even when it is temporarily unservable', async () => {
  configuredDefault = 'kortix/codex/gpt-6';
  expect((await access('PUT')).defaultModel).toBeUndefined();
  expect(changes[0]?.defaultModel).toBe('codex/gpt-6');
});
