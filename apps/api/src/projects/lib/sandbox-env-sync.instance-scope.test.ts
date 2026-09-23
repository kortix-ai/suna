// Instance scope on the project-wide env-sync fan-out.
//
// `propagateProjectSecretsToActiveSandboxes` enumerates EVERY active box of a
// project and pushes this instance's env — including its `KORTIX_URL`-derived
// gateway URL — into each one. On a shared local DB that is how one worktree's
// dead tunnel ended up inside another worktree's sandbox (2026-08-22, twice).
// With `KORTIX_INSTANCE_ID` set, boxes stamped by another instance are skipped
// and not counted as targets; legacy rows (no stamp) and own rows are pushed.
// With it unset, nothing changes.
//
// The per-prompt push (`syncSandboxEnvForPrompt`) and the gateway-mode fan-out
// follow the same rule for the gateway URL: a box another instance provisioned
// keeps the URL its owner gave it. 2026-09-22: a command enqueued before its
// session's sandbox row existed was executed by the OTHER API on the same DB,
// which pushed its own tunnel URL; the owner's next push flipped it back, and
// each flip disposed OpenCode — the second one mid-turn, killing a tool loop.
//
// Same `mock.module` + `globalThis.fetch` pattern as the sibling
// `sandbox-env-sync.refresh-models.test.ts` (runs isolated per file).
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';

const PROJECT_ROW = {
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  metadata: null as Record<string, unknown> | null,
};
const SESSION_ROW = {
  createdBy: 'user-1',
  agentName: 'support',
  secretsAllowlist: null as string[] | null,
};

type SandboxRow = {
  externalId: string | null;
  sessionId: string;
  provider: string;
  config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};
let sandboxRows: SandboxRow[] = [];
/** The row `syncSandboxEnvForPrompt` reads to learn which instance owns a box. */
let promptSandboxMetadata: Record<string, unknown> | null = null;

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const wantsSandboxes = 'externalId' in columns && 'sessionId' in columns;
          const wantsSession = 'createdBy' in columns;
          const wantsOwner = 'sandboxMetadata' in columns;
          const rows = wantsOwner
            ? [{ sandboxMetadata: promptSandboxMetadata }]
            : wantsSandboxes
              ? sandboxRows
              : wantsSession
                ? [SESSION_ROW]
                : [PROJECT_ROW];
          return {
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionSecretGrant: async () => 'all' as const,
}));
mock.module('../secrets', () => ({
  ...realSecrets,
  listProjectSecretsSnapshotForUser: async () => ({
    env: { EXAMPLE: 'v1' },
    names: ['EXAMPLE'],
    revision: 'rev-1',
    capabilitiesJson: '{"version":1,"capabilities":[]}',
  }),
}));
mock.module('./network-secret-boundary', () => ({
  resolveSessionNetworkBoundary: async () => [],
}));
mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => true,
  projectLlmGatewayEnabledById: async () => true,
}));
mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async (externalId: string) => ({
    url: `https://daemon.test/${externalId}`,
    headers: {},
  }),
}));

/** External ids whose daemon received an env push, in order. */
let pushed: string[] = [];
/** The JSON bodies of those pushes, same order. */
let pushedBodies: Record<string, unknown>[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: string }) => {
  const href = String(url);
  const externalId = new URL(href).pathname.split('/')[1]!;
  pushed.push(externalId);
  const body = init?.body ? (JSON.parse(init.body) as { revision?: unknown }) : {};
  pushedBodies.push(body as Record<string, unknown>);
  return Response.json({
    ok: true,
    revision: body.revision,
    exported: 1,
    managed: 1,
    withheld: 0,
    agent_env_written: true,
    opencode: 'ok',
  });
};

const {
  propagateProjectSecretsToActiveSandboxes,
  propagateLlmGatewayModeToActiveSandboxes,
  syncSandboxEnvForPrompt,
  __resetPromptModelSignatureCacheForTests,
} = await import('./sandbox-env-sync');
const { config } = await import('../../config');
const ORIGINAL_INSTANCE = (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID;
const setInstance = (value: string | undefined) => {
  (config as { KORTIX_INSTANCE_ID?: string }).KORTIX_INSTANCE_ID = value;
};

function row(externalId: string, metadata: Record<string, unknown> | null): SandboxRow {
  return {
    externalId,
    sessionId: `sess-${externalId}`,
    provider: 'daytona',
    config: { serviceKey: `svc-${externalId}` },
    metadata,
  };
}

let projectSeq = 0;
/** A fresh project id per call: the runner is coalesced PER PROJECT, and a
 *  second call within its cooldown would wait on the first. */
const nextProject = () => `proj-scope-${++projectSeq}`;

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
beforeEach(() => {
  pushed = [];
  pushedBodies = [];
  promptSandboxMetadata = null;
  __resetPromptModelSignatureCacheForTests();
  sandboxRows = [
    row('ext-mine', { instanceId: 'wt-a' }),
    row('ext-legacy', null),
    row('ext-foreign', { instanceId: 'primary' }),
  ];
});
afterEach(() => setInstance(ORIGINAL_INSTANCE));

describe('propagateProjectSecretsToActiveSandboxes — instance scope', () => {
  test('KORTIX_INSTANCE_ID set → pushes to own + legacy boxes, skips another instance’s box', async () => {
    setInstance('wt-a');

    const report = await propagateProjectSecretsToActiveSandboxes(nextProject());

    expect(pushed.sort()).toEqual(['ext-legacy', 'ext-mine']);
    expect(report.targeted).toBe(2);
    expect(report.synced).toBe(2);
    expect(report.failed).toBe(0);
    // The foreign box is neither a target nor a failure: it is simply not ours.
    expect(report.results.map((r) => r.sandbox_id).sort()).toEqual(['ext-legacy', 'ext-mine']);
  });

  test('KORTIX_INSTANCE_ID unset → every active box is pushed (deployed envs unchanged)', async () => {
    setInstance(undefined);

    const report = await propagateProjectSecretsToActiveSandboxes(nextProject());

    expect(pushed.sort()).toEqual(['ext-foreign', 'ext-legacy', 'ext-mine']);
    expect(report.targeted).toBe(3);
    expect(report.synced).toBe(3);
  });
});

function promptPush(externalId: string) {
  return syncSandboxEnvForPrompt({
    projectId: nextProject(),
    sessionId: `sess-${externalId}`,
    externalId,
    serviceKey: 'svc-key',
    previewUrl: `https://daemon.test/${externalId}`,
    providerHeaders: {},
    providerName: 'daytona',
  });
}

describe('syncSandboxEnvForPrompt — gateway URL is owned by the provisioning instance', () => {
  test("another instance's box: the push carries no gateway mode or base URL", async () => {
    setInstance('wt-a');
    promptSandboxMetadata = { instanceId: 'primary' };

    await promptPush('ext-foreign');

    expect(pushed).toEqual(['ext-foreign']);
    expect(pushedBodies[0]).not.toHaveProperty('llmGatewayEnabled');
    expect(pushedBodies[0]).not.toHaveProperty('llmGatewayBaseUrl');
    // Secrets are instance-independent (one DB) and still delivered.
    expect(pushedBodies[0]).toHaveProperty('env', { EXAMPLE: 'v1' });
  });

  test('own box: the push carries this instance’s gateway base URL', async () => {
    setInstance('wt-a');
    promptSandboxMetadata = { instanceId: 'wt-a' };

    await promptPush('ext-mine');

    expect(pushedBodies[0]).toHaveProperty('llmGatewayEnabled', true);
    expect(typeof pushedBodies[0]!.llmGatewayBaseUrl).toBe('string');
  });

  test('legacy box (no stamp) and scoping off: the gateway URL is pushed as before', async () => {
    setInstance('wt-a');
    promptSandboxMetadata = null;
    await promptPush('ext-legacy');
    setInstance(undefined);
    promptSandboxMetadata = { instanceId: 'primary' };
    await promptPush('ext-deployed');

    expect(pushedBodies).toHaveLength(2);
    for (const body of pushedBodies) {
      expect(body).toHaveProperty('llmGatewayEnabled', true);
      expect(typeof body.llmGatewayBaseUrl).toBe('string');
    }
  });
});

describe('propagateLlmGatewayModeToActiveSandboxes — instance scope', () => {
  test("KORTIX_INSTANCE_ID set → another instance's box is not pushed", async () => {
    setInstance('wt-a');

    await propagateLlmGatewayModeToActiveSandboxes(nextProject(), true);

    expect(pushed.sort()).toEqual(['ext-legacy', 'ext-mine']);
  });

  test('KORTIX_INSTANCE_ID unset → every active box is pushed', async () => {
    setInstance(undefined);

    await propagateLlmGatewayModeToActiveSandboxes(nextProject(), true);

    expect(pushed.sort()).toEqual(['ext-foreign', 'ext-legacy', 'ext-mine']);
  });
});
