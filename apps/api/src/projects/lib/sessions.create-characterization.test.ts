import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { config } from '../../config';

// Run alone: Bun module mocks are process-global.
let atCap = false;
let billing: Record<string, unknown> = { ok: true };
let inserted: Record<string, unknown> | undefined;
/** The billing entitlement under test. False = free tier (KRTX-1067). */
let mayUseManagedModels = true;

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
// The default chain a fresh account's model pin flows through. Nothing is
// stored, so it resolves to "the platform default applies".
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
  mayUseManagedModels = true;
  config.KORTIX_URL = 'https://api.example.test';
  // A non-default operator config, so the free-tier test can tell the RESOLVED
  // platform default apart from the PAID path's raw config fallback.
  config.LLM_GATEWAY_DEFAULT_MODEL = 'glm-5.3-flash';
});
afterAll(() => {
  config.KORTIX_URL = originalKortixUrl;
  config.LLM_GATEWAY_DEFAULT_MODEL = originalDefaultModel;
});

test('cap 429 takes precedence over simultaneous billing 402 without inserting', async () => {
  atCap = true;
  billing = { ok: false, message: 'Payment required', reason: 'insufficient_balance' };
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body: {} });
  expect(result.error?.status).toBe(429);
  expect(result.error?.body.code).toBe('concurrent_session_limit');
  expect(inserted).toBeUndefined();
});

test('insert stores the exact create-time metadata fields and override order', async () => {
  const result = await createProjectSession({
    project, userId: 'synthetic-user', requestingPrincipalType: 'human',
    body: { name: '  Chosen name  ', metadata: { custom_name: 'old', source: 'body', arbitrary: 7 } },
    metadata: { source: 'trigger' },
  });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toEqual({
    arbitrary: 7, custom_name: 'Chosen name', source: 'trigger',
    repository_access: false, repository_generation: null, workspace_mode: 'runtime',
    sandbox_slug: 'default',
    audit_v2: {
      actor_type: 'human', authoritative_source: 'human',
      initiator_actor_type: null, initiator_actor_id: null, delegation_depth: 0,
    },
  });
});

// KRTX-1067: the boot model of a session with nothing stored. The gateway
// serves the platform default to every tier, so a fresh FREE account must boot
// pinned to it — an unpinned session was the dead composer of the bug report.
test('a fresh free-tier account boots pinned to the platform default', async () => {
  mayUseManagedModels = false;
  config.LLM_GATEWAY_ENABLED = true;
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body: {} });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toMatchObject({
    opencode_model: 'kortix/deepseek-v4.1-flash',
    opencode_model_source: 'platform',
  });
});

test('a paid account keeps the raw operator config as its boot fallback', async () => {
  mayUseManagedModels = true;
  config.LLM_GATEWAY_ENABLED = true;
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body: {} });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toMatchObject({
    opencode_model: 'kortix/glm-5.3-flash',
    opencode_model_source: 'platform',
  });
});
