import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { config } from '../../config';

// Run alone: Bun module mocks are process-global.
let billing: Record<string, unknown> = { ok: true };
let inserted: Record<string, unknown> | undefined;

mock.module('../../billing/services/billing-gate', () => ({ checkBillingAdmission: async () => billing }));
mock.module('../../billing/services/entitlements', () => ({ accountMayUseManagedModels: async () => true }));
mock.module('../../shared/audit', () => ({ recordAuditEvent: async () => {} }));
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

const originalKortixUrl = config.KORTIX_URL;
beforeEach(() => {
  billing = { ok: true };
  inserted = undefined;
  config.KORTIX_URL = 'https://api.example.test';
});
afterAll(() => { config.KORTIX_URL = originalKortixUrl; });

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
    repository_access: false, repository_generation: null, workspace_mode: 'runtime',
    sandbox_slug: 'default',
    audit_v2: {
      actor_type: 'human', authoritative_source: 'human',
      initiator_actor_type: null, initiator_actor_id: null, delegation_depth: 0,
    },
  });
});
