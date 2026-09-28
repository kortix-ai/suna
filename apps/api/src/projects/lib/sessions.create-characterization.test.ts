import { beforeEach, expect, mock, test } from 'bun:test';

// Run alone: Bun module mocks are process-global.
let atCap = false;
let billing: Record<string, unknown> = { ok: true };
let inserted: Record<string, unknown> | undefined;

mock.module('../../billing/services/billing-gate', () => ({ checkBillingAdmission: async () => billing }));
mock.module('../../billing/services/entitlements', () => ({ accountMayUseManagedModels: async () => true }));
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

import { createProjectSession } from './sessions';

const project = {
  projectId: 'synthetic-project', accountId: 'synthetic-account', defaultBranch: 'main',
  metadata: {}, repoUrl: 'https://example.test/repo', manifestPath: 'kortix.yaml',
} as Parameters<typeof createProjectSession>[0]['project'];

beforeEach(() => { atCap = false; billing = { ok: true }; inserted = undefined; });

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
      actor_type: 'human', authoritative_source: 'human', client_reported_source: null,
      initiator_actor_type: null, initiator_actor_id: null, delegation_depth: 0,
    },
  });
});
