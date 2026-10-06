// Where a `pi_cell` session lands (session-create.ts resolveSessionSandboxPlacement):
// the reserved `pi-cell` slug, Platinum locked, no project image, and
// `pi_cell_boot` in the provision metadata. Only the flag selects the slug;
// a request cannot name it, and a gateway-off project keeps its sandbox.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { config } from '../../config';

// Run alone: Bun module mocks are process-global.
let inserted: Record<string, unknown> | undefined;
let provisioned: Record<string, unknown> | undefined;
let manifestSandboxType: 'worker' | 'vm' | null = null;

mock.module('../../billing/services/billing-gate', () => ({ checkBillingAdmission: async () => ({ ok: true }) }));
mock.module('../../billing/services/entitlements', () => ({ accountMayUseManagedModels: async () => true }));
mock.module('../../shared/audit', () => ({ recordAuditEvent: async () => {} }));
mock.module('../agents', () => ({
  loadProjectAgents: async () => ({ defaultAgent: 'default', sandboxType: manifestSandboxType }),
  repositoryAccessFromLoadedAgents: () => true,
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
mock.module('../../platform/services/session-sandbox', () => ({
  provisionSessionSandbox: async (opts: Record<string, unknown>) => { provisioned = opts; },
}));
mock.module('./git', () => ({ withProjectGitAuth: async (project: unknown) => project }));
// The gateway's default-model lookup reads the database; this test is about placement.
mock.module('../../llm-gateway/resolution/default-model', () => ({
  resolveEffectiveModel: async () => ({ model: 'kortix/synthetic-model', source: 'platform' }),
  isModelServableForAccount: async () => true,
}));
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
import { sessionRunsInCell } from './session-create';

type Project = Parameters<typeof createProjectSession>[0]['project'];
const projectWith = (experimental: Record<string, boolean>): Project => ({
  projectId: 'synthetic-project', accountId: 'synthetic-account', defaultBranch: 'main',
  metadata: { experimental }, repoUrl: 'https://example.test/repo', manifestPath: 'kortix.yaml',
} as unknown as Project);

const saved = {
  KORTIX_URL: config.KORTIX_URL,
  KORTIX_PI_CELL_ENABLED: config.KORTIX_PI_CELL_ENABLED,
  PLATINUM_API_KEY: config.PLATINUM_API_KEY,
  LLM_GATEWAY_ENABLED: config.LLM_GATEWAY_ENABLED,
  KORTIX_PI_CELL_DEFAULT_ENABLED: config.KORTIX_PI_CELL_DEFAULT_ENABLED,
};
beforeEach(() => {
  inserted = undefined;
  provisioned = undefined;
  config.KORTIX_URL = 'https://api.example.test';
  config.KORTIX_PI_CELL_ENABLED = true;
  config.PLATINUM_API_KEY = 'pt_synthetic';
  config.LLM_GATEWAY_ENABLED = true;
  config.KORTIX_PI_CELL_DEFAULT_ENABLED = false;
  manifestSandboxType = null;
});
afterAll(() => { Object.assign(config, saved); });

async function create(project: Project, body: Record<string, unknown> = {}, metadata?: Record<string, unknown>) {
  const result = await createProjectSession({ project, userId: 'synthetic-user', requestingPrincipalType: 'human', body, metadata });
  // Provisioning is fire-and-forget after the row exists.
  for (let i = 0; i < 100 && !provisioned && !result.error; i++) await new Promise((r) => setTimeout(r, 10));
  return result;
}

test('pi_cell with the gateway on: the reserved slug, Platinum locked, no project image, pi_cell_boot', async () => {
  const result = await create(projectWith({ pi_cell: true, llm_gateway: true }));
  expect(result.error).toBeUndefined();
  expect((inserted?.metadata as Record<string, unknown>).sandbox_slug).toBe('pi-cell');
  expect(provisioned?.sandboxSlug).toBe('pi-cell');
  expect(provisioned?.provider).toBe('platinum');
  expect(provisioned?.providerLocked).toBe(true);
  expect(provisioned?.allowProjectImage).toBe(false);
  expect((provisioned?.metadata as Record<string, unknown>).pi_cell_boot).toBe(true);
});

test('pi_cell with the gateway off keeps the ordinary sandbox: the cell has no other model path', async () => {
  const result = await create(projectWith({ pi_cell: true, llm_gateway: false }));
  expect(result.error).toBeUndefined();
  expect((inserted?.metadata as Record<string, unknown>).sandbox_slug).toBe('default');
  expect((provisioned?.metadata as Record<string, unknown>).pi_cell_boot).toBeUndefined();
});

test('pi_cell where the operator has not enabled cells keeps the ordinary sandbox', async () => {
  config.KORTIX_PI_CELL_ENABLED = false;
  const result = await create(projectWith({ pi_cell: true, llm_gateway: true }));
  expect(result.error).toBeUndefined();
  expect((inserted?.metadata as Record<string, unknown>).sandbox_slug).toBe('default');
});

test('a request cannot name the reserved slug: 400 SANDBOX_SLUG_RESERVED, nothing inserted', async () => {
  const result = await create(projectWith({}), { sandbox_slug: 'pi-cell' });
  expect(result.error?.status).toBe(400);
  expect(result.error?.body.code).toBe('SANDBOX_SLUG_RESERVED');
  expect(inserted).toBeUndefined();
});

test('caller metadata cannot make a cell: pi_cell_boot from the caller leaves the slug ordinary', async () => {
  const result = await create(projectWith({}), {}, { pi_cell_boot: true });
  expect(result.error).toBeUndefined();
  expect(provisioned?.sandboxSlug).toBe('default');
});

// ── Who decides: kortix.yaml `sandbox.type`, else the flag (whose default is
// the platform's KORTIX_PI_CELL_DEFAULT_ENABLED). ──────────────────────────

test('where the platform defaults to cells, a project with no choice of its own gets a cell', async () => {
  config.KORTIX_PI_CELL_DEFAULT_ENABLED = true;
  const result = await create(projectWith({ llm_gateway: true }));
  expect(result.error).toBeUndefined();
  expect(provisioned?.sandboxSlug).toBe('pi-cell');
});

test('the project switch still opts out where the platform defaults to cells', async () => {
  config.KORTIX_PI_CELL_DEFAULT_ENABLED = true;
  const result = await create(projectWith({ llm_gateway: true, pi_cell: false }));
  expect(result.error).toBeUndefined();
  expect(provisioned?.sandboxSlug).toBe('default');
});

test('kortix.yaml sandbox.type: worker gets a cell with the switch off', async () => {
  manifestSandboxType = 'worker';
  const result = await create(projectWith({ llm_gateway: true, pi_cell: false }));
  expect(result.error).toBeUndefined();
  expect(provisioned?.sandboxSlug).toBe('pi-cell');
  expect((provisioned?.metadata as Record<string, unknown>).pi_cell_boot).toBe(true);
});

test('kortix.yaml sandbox.type: vm gets a microVM even with the switch on and cells the default', async () => {
  manifestSandboxType = 'vm';
  config.KORTIX_PI_CELL_DEFAULT_ENABLED = true;
  const result = await create(projectWith({ llm_gateway: true, pi_cell: true }));
  expect(result.error).toBeUndefined();
  expect(provisioned?.sandboxSlug).toBe('default');
});

test('kortix.yaml sandbox.type: worker where the platform runs no cells boots a microVM, not an error', async () => {
  manifestSandboxType = 'worker';
  config.KORTIX_PI_CELL_ENABLED = false;
  const result = await create(projectWith({ llm_gateway: true }));
  expect(result.error).toBeUndefined();
  expect(provisioned?.sandboxSlug).toBe('default');
});

test('a session that resolved a custom template stays a microVM: a cell boots no image', () => {
  const project = projectWith({ llm_gateway: true, pi_cell: true });
  expect(sessionRunsInCell({ project, sandboxSlug: 'default', declared: null })).toBe(true);
  expect(sessionRunsInCell({ project, sandboxSlug: 'py', declared: null })).toBe(false);
  expect(sessionRunsInCell({ project, sandboxSlug: 'py', declared: 'worker' })).toBe(false);
});
