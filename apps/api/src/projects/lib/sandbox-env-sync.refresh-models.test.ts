// T3: `syncSandboxEnvForPrompt` used to post `refreshModels: true`
// unconditionally on every `/prompt_async|/message|/command` turn. The daemon
// already no-ops a byte-identical push (routes/env.ts's
// `result.changed || opencodeEnvChanged` gate), but the API kept asking on
// every steady-state turn anyway. This pins the API-side half: the per-prompt
// hot path now remembers the last config-affecting payload it delivered to
// EACH sandbox and only sets `refreshModels: true` when that payload actually
// moved — an identical resend, and post-wake's first real change, are both
// asserted here.
//
// Uses the same `mock.module` + `globalThis.fetch` interception pattern as
// `sandbox-env-sync.prompt.test.ts` (this suite runs isolated per file via
// `bun test --isolate`, so the module-level mocks below are safe).
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import { applyEnvSyncDurableWrite, firstBoundString } from '../../__tests__/helpers/env-sync-durable-fake';
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

/** Mutable per-test secrets snapshot — flip these to simulate a real change
 *  between two prompts on the same sandbox. */
let snapshotEnv: Record<string, string> = { EXAMPLE: 'v1' };
let snapshotNames: string[] = ['EXAMPLE'];
let snapshotRevision = 'rev-1';
let snapshotCapabilitiesJson = '{"version":1,"capabilities":[]}';
/** Each session's sandbox-row `config`: the durable env-sync record every push writes. */
const sandboxConfigs = new Map<string, Record<string, unknown> | null>();

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: (condition: unknown) => {
          // `resolveOwnerRawEnv` selects the session row, then the project row.
          // `resolveProjectLlmGatewayEnabled` selects a project row shaped like
          // `{ metadata }` only. Route on the requested column set so one fake
          // `db` satisfies every select on this path, same as the sibling
          // `sandbox-env-sync.prompt.test.ts`.
          const wantsSession = 'createdBy' in columns;
          const wantsSandboxConfig = !wantsSession && Object.keys(columns).length === 1 && 'config' in columns;
          const rows = wantsSession
            ? [SESSION_ROW]
            : wantsSandboxConfig
              ? [{ config: sandboxConfigs.get(firstBoundString(condition) ?? '') ?? null }]
              : [PROJECT_ROW];
          return {
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: () => ({
      set: (patch: { config?: unknown }) => ({
        where: async (condition: unknown) => {
          const sessionId = firstBoundString(condition) ?? '';
          sandboxConfigs.set(sessionId, applyEnvSyncDurableWrite(sandboxConfigs.get(sessionId) ?? null, patch.config));
        },
      }),
    }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionSecretGrant: async () => 'all' as const,
}));

/** Resolves the snapshot read; a test replaces it to hold the read open. */
let snapshotGate: Promise<void> = Promise.resolve();
mock.module('../secrets', () => ({
  ...realSecrets,
  listProjectSecretsSnapshotForUser: async () => (await snapshotGate, {
    env: snapshotEnv,
    names: snapshotNames,
    revision: snapshotRevision,
    capabilitiesJson: snapshotCapabilitiesJson,
  }),
}));

mock.module('./network-secret-boundary', () => ({
  // Daytona is on-demand (see platform/providers): zero bindings means the
  // network-boundary leg is a complete no-op, so this suite never has to
  // touch `platform/providers`.
  resolveSessionNetworkBoundary: async () => [],
}));

type PostedBody = {
  revision: unknown;
  refreshModels: unknown;
  opencodeEnv: Record<string, unknown>;
};
let posted: PostedBody[] = [];

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ? (JSON.parse(init.body) as PostedBody) : ({} as PostedBody);
  posted.push(body);
  return Response.json({
    ok: true,
    revision: body.revision,
    exported: 1,
    managed: 1,
    withheld: 0,
    agent_env_written: true,
    // Steady state: the daemon is already serving. A real reload would answer
    // e.g. 'starting', but nothing here exercises the readiness wait.
    opencode: 'ok',
  });
};

const { syncSandboxEnvForPrompt, __resetPromptModelSignatureCacheForTests, __pendingEnvChecksForTests } =
  await import('./sandbox-env-sync');

/** One box per session, as in production: `ext-2` is the box of `sess-2`. */
function prompt(externalId = 'ext-1', requestedAgent?: string) {
  return syncSandboxEnvForPrompt({
    projectId: 'proj-1',
    sessionId: externalId.replace('ext-', 'sess-'),
    externalId,
    serviceKey: 'svc-key',
    previewUrl: 'https://sandbox.test',
    providerHeaders: {},
    providerName: 'daytona',
    requestedAgent,
  });
}

/**
 * A change lands one prompt late. The prompt after a confirmed sync is trusted:
 * it is forwarded at once, its background check finds the change and pushes
 * nothing, and the NEXT prompt pushes synchronously.
 */
async function promptAfterChange() {
  const before = posted.length;
  await prompt();
  await Promise.all(__pendingEnvChecksForTests());
  expect(posted.length).toBe(before);
  await prompt();
}

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  __resetPromptModelSignatureCacheForTests();
  sandboxConfigs.clear();
  posted = [];
  snapshotGate = Promise.resolve();
  snapshotEnv = { EXAMPLE: 'v1' };
  snapshotNames = ['EXAMPLE'];
  snapshotRevision = 'rev-1';
  snapshotCapabilitiesJson = '{"version":1,"capabilities":[]}';
  PROJECT_ROW.metadata = null;
});

describe('syncSandboxEnvForPrompt — refreshModels gating', () => {
  test('the first prompt on a cold cache asks for a reload', async () => {
    await prompt();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.refreshModels).toBe(true);
  });

  test('two identical prompts in a row push ONCE — the byte-identical follow-ups skip the daemon', async () => {
    // The daemon would no-op an identical push; the round-trip itself was ~1s
    // of dead air on every queued message. An unchanged signature does not
    // reach the box at all — indefinitely, not just within a TTL window (see
    // `decideEnvSyncAction`).
    await prompt();
    await prompt();
    await prompt();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.refreshModels).toBe(true);
  });

  test('a project-secret value change still asks for a reload', async () => {
    // This must NOT be narrowed to "model" fields — a rotated project secret
    // is the daemon's ONLY signal to respawn opencode so its process env picks
    // up the new value (see the comment on `promptModelSignature`).
    await prompt();
    snapshotEnv = { EXAMPLE: 'v2' };
    snapshotRevision = 'rev-2';
    await promptAfterChange();

    expect(posted.map((p) => p.refreshModels)).toEqual([true, true]);
  });

  test('a new project secret being granted still asks for a reload', async () => {
    await prompt();
    snapshotEnv = { EXAMPLE: 'v1', STRIPE_KEY: 'sk_live_new' };
    snapshotNames = ['EXAMPLE', 'STRIPE_KEY'];
    snapshotRevision = 'rev-2';
    await promptAfterChange();

    expect(posted.map((p) => p.refreshModels)).toEqual([true, true]);
  });

  test('a secret-capability catalog change still asks for a reload', async () => {
    // Pushed as KORTIX_SECRET_CAPABILITIES, which is on the daemon's
    // RESPAWN_REQUIRED_ENV_NAMES list — see opencode.ts.
    await prompt();
    snapshotCapabilitiesJson =
      '{"version":1,"capabilities":[{"identifier":"WEATHER_API","delivery":"https_broker"}]}';
    await promptAfterChange();

    expect(posted.map((p) => p.refreshModels)).toEqual([true, true]);
  });

  test('an explicit caller opencodeEnv push still asks for a reload', async () => {
    // e.g. a caller moving KORTIX_MODEL through this same call
    // (see continue-session.ts's continueSession).
    await syncSandboxEnvForPrompt({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      externalId: 'ext-1',
      serviceKey: 'svc-key',
      previewUrl: 'https://sandbox.test',
      providerHeaders: {},
      providerName: 'daytona',
    });
    await syncSandboxEnvForPrompt({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      externalId: 'ext-1',
      serviceKey: 'svc-key',
      previewUrl: 'https://sandbox.test',
      providerHeaders: {},
      providerName: 'daytona',
      opencodeEnv: { KORTIX_MODEL: 'kortix/test-model' },
    });

    expect(posted.map((p) => p.refreshModels)).toEqual([true, true]);
  });

  test('the memo is per sandbox — a second box still gets its own first reload', async () => {
    await prompt('ext-1');
    await prompt('ext-2');
    await prompt('ext-1');
    await prompt('ext-2');

    // One push per box; the repeats are skipped entirely.
    expect(posted.map((p) => p.refreshModels)).toEqual([true, true]);
  });

  test('a failed push is not remembered — the retry still asks for a reload', async () => {
    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error('network blip');
    };
    await expect(prompt()).rejects.toThrow('network blip');

    (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as PostedBody) : ({} as PostedBody);
      posted.push(body);
      return Response.json({ ok: true, revision: body.revision, exported: 1, opencode: 'ok' });
    };
    await prompt();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.refreshModels).toBe(true);
  });
});

describe('syncSandboxEnvForPrompt — trusted fast path', () => {
  test('a prompt after a confirmed sync does not wait for the env resolve', async () => {
    await prompt();
    let release!: () => void;
    snapshotGate = new Promise((resolve) => {
      release = resolve;
    });
    // Would hang here if the prompt still awaited the snapshot read.
    await prompt();
    expect(__pendingEnvChecksForTests()).toHaveLength(1);
    release();
    await Promise.all(__pendingEnvChecksForTests());
    expect(posted).toHaveLength(1);
  });

  test('a different agent is never trusted: its env resolves before the prompt', async () => {
    await prompt();
    await prompt('ext-1', 'reviewer');
    expect(__pendingEnvChecksForTests()).toHaveLength(0);
    // Trusted again for that agent from now on.
    await prompt('ext-1', 'reviewer');
    expect(__pendingEnvChecksForTests()).toHaveLength(1);
  });
});
