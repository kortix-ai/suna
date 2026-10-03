import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { config } from '../../config';

// Run alone: Bun module mocks are process-global. Same mock set as
// sessions.create-characterization.test.ts, plus the resolution layer a fresh
// account's model pin flows through.
let atCap = false;
let billing: Record<string, unknown> = { ok: true };
let inserted: Record<string, unknown> | undefined;
/** The billing entitlement under test: false = free tier (KRTX-1067). */
let mayUseManagedModels = false;

mock.module('../../billing/services/billing-gate', () => ({ checkBillingAdmission: async () => billing }));
mock.module('../../billing/services/entitlements', () => ({ accountMayUseManagedModels: async () => mayUseManagedModels }));
mock.module('../../shared/audit', () => ({ recordAuditEvent: async () => {} }));
mock.module('../../shared/account-limits', () => ({
  resolveAccountSessionLimit: async () => ({ tier: 'starter', limit: 1, source: 'tier' }),
}));
mock.module('../agents', () => ({
  loadProjectAgents: async () => ({ defaultAgent: 'default' }),
  repositoryAccessFromLoadedAgents: () => false,
  legacyReadWorkspaceFromLoadedAgents: () => false,
  sandboxFromLoadedAgents: () => null,
}));
mock.module('./session-connector-bindings', () => ({
  parseSessionConnectorBindings: () => ({ ok: true, bindings: undefined }),
  validateSessionConnectorBindings: async () => ({ ok: true, bindings: [] }),
  sessionConnectorBindingsRequirePrivateVisibility: () => false,
}));
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ activeCount: atCap ? 1 : 0 }] }) }) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn({
      insert: () => ({ values: (value: Record<string, unknown>) => {
        inserted = value;
        return { returning: async () => [value] };
      } }),
    }),
  },
}));
mock.module('../../platform/services/session-sandbox', () => ({ provisionSessionSandbox: async () => {} }));
mock.module('./git', () => ({ withProjectGitAuth: async (project: unknown) => project }));
mock.module('../../git-proxy/project-snapshot', () => ({
  resolveProjectSnapshotMode: () => 'git',
  resolveProjectSnapshotPinForSession: async () => ({ pin: null, descriptor: null }),
}));
mock.module('./session-runtime-context', () => ({
  parseSessionRuntimeContext: () => ({ ok: true }),
  mergeSessionSandboxEnv: (env: unknown) => env,
  buildSessionRuntimeContextEnv: () => ({}),
}));
// A fresh account has nothing stored, so the default chain resolves to
// "the platform default applies". The mock answers exactly that.
mock.module('../../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async () => true,
  resolveEffectiveModel: async () => ({ model: null, source: 'platform' as const }),
}));
mock.module('../../llm-gateway/models/served-managed-models', () => ({
  platformDefaultModelId: () => 'deepseek-v4.1-flash',
  isPlatformDefaultModelId: (id: string) => id === 'deepseek-v4.1-flash',
}));

import { createProjectSession } from './sessions';

const project = {
  projectId: 'synthetic-project', accountId: 'synthetic-account', defaultBranch: 'main',
  metadata: {}, repoUrl: 'https://example.test/repo', manifestPath: 'kortix.yaml',
} as Parameters<typeof createProjectSession>[0]['project'];

const originalKortixUrl = config.KORTIX_URL;
const originalDefaultModel = config.LLM_GATEWAY_DEFAULT_MODEL;
beforeEach(() => {
  atCap = false;
  billing = { ok: true };
  inserted = undefined;
  mayUseManagedModels = false;
  config.KORTIX_URL = 'https://api.example.test';
  config.LLM_GATEWAY_ENABLED = true;
  // A non-default operator config, so the test can tell the FREE path's
  // resolved platform default apart from the PAID path's raw config fallback.
  config.LLM_GATEWAY_DEFAULT_MODEL = 'glm-5.3-flash';
});
afterAll(() => {
  config.KORTIX_URL = originalKortixUrl;
  config.LLM_GATEWAY_DEFAULT_MODEL = originalDefaultModel;
});

test('a fresh free-tier account boots pinned to the platform default (KRTX-1067)', async () => {
  mayUseManagedModels = false;
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body: {} });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toMatchObject({
    opencode_model: 'kortix/deepseek-v4.1-flash',
    opencode_model_source: 'platform',
  });
});

test('a paid account keeps the raw operator config as its boot fallback', async () => {
  mayUseManagedModels = true;
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body: {} });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toMatchObject({
    opencode_model: 'kortix/glm-5.3-flash',
    opencode_model_source: 'platform',
  });
});
