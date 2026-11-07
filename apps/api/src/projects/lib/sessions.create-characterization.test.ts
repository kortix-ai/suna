import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { config } from '../../config';

// Run alone: Bun module mocks are process-global.
let billing: Record<string, unknown> = { ok: true };
let inserted: Record<string, unknown> | undefined;
/** The billing entitlement under test. False = free tier (KRTX-1067). */
let mayUseManagedModels = true;

mock.module('../../billing/services/billing-gate', () => ({ checkBillingAdmission: async () => billing }));
mock.module('../../billing/services/entitlements', () => ({ accountMayUseManagedModels: async () => mayUseManagedModels }));
mock.module('../../shared/audit', () => ({ recordAuditEvent: async () => {} }));
mock.module('../agents', () => ({
  loadProjectAgents: async () => ({ defaultAgent: 'default', builtinAgents: { my_kortix: false } }),
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
let servable = (_model: string) => true;
mock.module('../../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async ({ model }: { model: string }) => servable(model),
  resolveEffectiveModel: async () => ({ model: null, source: 'platform' as const }),
}));
mock.module('../../llm-gateway/models/served-managed-models', () => ({
  platformDefaultModelId: () => 'deepseek-v4.1-flash',
  isPlatformDefaultModelId: (id: string) => id === 'deepseek-v4.1-flash',
  servedManagedModels: () => [],
  platformVisionModelId: () => '',
}));

import { createProjectSession } from './sessions';

// My Kortix runs only when kortix.yaml turns it on. This suite characterizes the
// ordinary (non-My Kortix) session-create path — model pin, metadata fields,
// sandbox slug — so its mocked manifest sets `builtin_agents.my_kortix: false`.
// The My Kortix path has its own coverage in unit-my-kortix-agent.test.ts.
const project = {
  projectId: 'synthetic-project', accountId: 'synthetic-account', defaultBranch: 'main',
  metadata: {}, repoUrl: 'https://example.test/repo', manifestPath: 'kortix.yaml',
} as unknown as Parameters<typeof createProjectSession>[0]['project'];

const originalKortixUrl = config.KORTIX_URL;
const originalDefaultModel = config.LLM_GATEWAY_DEFAULT_MODEL;
beforeEach(() => {
  billing = { ok: true };
  inserted = undefined;
  mayUseManagedModels = true;
  servable = () => true;
  config.KORTIX_URL = 'https://api.example.test';
  // A non-default operator config, so the free-tier test can tell the RESOLVED
  // platform default apart from the PAID path's raw config fallback.
  config.LLM_GATEWAY_DEFAULT_MODEL = 'glm-5.3-flash';
});
afterAll(() => {
  config.KORTIX_URL = originalKortixUrl;
  config.LLM_GATEWAY_DEFAULT_MODEL = originalDefaultModel;
});

test('billing 402 is the only create gate and inserts nothing', async () => {
  billing = { ok: false, message: 'Payment required', reason: 'insufficient_balance' };
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body: {} });
  expect(result.error?.status).toBe(402);
  expect(result.error?.body.code).not.toBe('concurrent_session_limit');
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
    model: 'kortix/deepseek-v4.1-flash', model_source: 'platform',
    repository_access: false, repository_generation: null, workspace_mode: 'runtime',
    sandbox_slug: 'default',
    audit_v2: {
      actor_type: 'human', authoritative_source: 'human',
      initiator_actor_type: null, initiator_actor_id: null, delegation_depth: 0,
    },
  });
});

// KRTX-1547: the CLI spawn prompt is the caller's words, verbatim; the worker
// contract rides in `initial_context` and reaches the model only.
test('initial_prompt is stored verbatim and initial_context rides beside it', async () => {
  const result = await createProjectSession({
    project, userId: 'synthetic-user', requestingPrincipalType: 'human',
    body: {
      initial_prompt: 'Reply with the single word pong',
      initial_context: '--- session contract ---\nDo not spawn other sessions.',
    },
  });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toMatchObject({
    initial_prompt: 'Reply with the single word pong',
    initial_context: '--- session contract ---\nDo not spawn other sessions.',
  });
});

test('an oversized initial_context is refused and inserts nothing', async () => {
  const result = await createProjectSession({
    project, userId: 'synthetic-user', requestingPrincipalType: 'human',
    body: { initial_prompt: 'hi', initial_context: 'x'.repeat(8_193) },
  });
  expect(result.error?.status).toBe(400);
  expect(inserted).toBeUndefined();
});

// The boot model of a session with nothing stored. The gateway refuses every
// managed model to a FREE account, so it never boots pinned to the platform
// default: it runs its own connected model, or none.
test('a fresh free-tier account never boots pinned to a managed model', async () => {
  mayUseManagedModels = false;
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body: {} });
  expect(result.error).toBeUndefined();
  expect((inserted?.metadata as Record<string, unknown> | undefined)?.model).toBeUndefined();
});

test('a paid account boots on the resolved platform default (the configured id when Platinum serves it)', async () => {
  mayUseManagedModels = true;
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body: {} });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toMatchObject({
    model: 'kortix/deepseek-v4.1-flash',
    model_source: 'platform',
  });
});

// 2026-11-02 prod: the web names the model only on the first prompt. A free
// account has no default, so its box booted with no model and pi refused to
// start ("pi harness has no model"). The first prompt's pick is the boot model.
test('a free-tier account with no default boots on the model its first prompt picked', async () => {
  mayUseManagedModels = false;
  const result = await createProjectSession({
    project, userId: 'synthetic-user', requestingPrincipalType: 'human',
    body: { pending_prompt: { text: '', agent: 'default', model: { providerID: 'claude-agent', modelID: 'opus' } } },
  });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toMatchObject({ model: 'claude-agent/opus', model_source: 'explicit' });
});

test('a first-prompt pick the account cannot use, or an unknown Claude id, is not the boot model', async () => {
  mayUseManagedModels = false;
  servable = (model) => model !== 'openrouter/x';
  for (const model of [{ providerID: 'openrouter', modelID: 'x' }, { providerID: 'claude-agent', modelID: 'gpt-9' }]) {
    inserted = undefined;
    const result = await createProjectSession({
      project, userId: 'synthetic-user', requestingPrincipalType: 'human',
      body: { pending_prompt: { text: '', model } },
    });
    expect(result.error).toBeUndefined();
    expect(((inserted as { metadata?: Record<string, unknown> } | undefined)?.metadata)?.model).toBeUndefined();
  }
});

test('a paid account keeps its default as the boot model; the first prompt still carries its pick', async () => {
  const result = await createProjectSession({
    project, userId: 'synthetic-user', requestingPrincipalType: 'human',
    body: { pending_prompt: { text: '', model: { providerID: 'claude-agent', modelID: 'opus' } } },
  });
  expect(result.error).toBeUndefined();
  expect(inserted?.metadata).toMatchObject({ model: 'kortix/deepseek-v4.1-flash', model_source: 'platform' });
});
