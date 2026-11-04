/**
 * `prefetchPromptEnv`: a new session's first prompt takes the env reads the
 * delivery started while the box booted, and resolves afresh whenever that
 * prefetch cannot vouch for this turn (another agent, another person, a failed
 * read, too old, already used).
 *
 * `mock.module` is process-global; this file owns its module graph under
 * `bun test --isolate` (see sandbox-env-sync.prompt.test.ts).
 */
import { afterAll, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { config } from '../../config';
import { applyEnvSyncDurableWrite, firstBoundString } from '../../__tests__/helpers/env-sync-durable-fake';

import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';

let secretsReads = 0;
let boundaryReads = 0;
let envPushes = 0;
let person: string | null = 'user-1';
let boundaryResolveError: Error | null = null;

const SESSION_ROW = {
  createdBy: 'user-1',
  agentName: 'support',
  secretsAllowlist: null,
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  metadata: null,
  sessionId: 'sess-1',
  externalId: 'ext-1',
  provider: 'platinum',
  config: { serviceKey: 'svc-key' },
};
const durableConfigs = new Map<string, Record<string, unknown> | null>();

mock.module('../../shared/db', () => ({
  db: {
    select: (columns: Record<string, unknown> = {}) => ({
      from: () => ({
        where: (condition: unknown) => {
          const keys = Object.keys(columns);
          const rows =
            keys.length === 1 && 'onBehalfOf' in columns
              ? [{ onBehalfOf: person }]
              : keys.length === 1 && 'config' in columns
                ? [{ ...SESSION_ROW, config: durableConfigs.get(firstBoundString(condition) ?? '') ?? null }]
                : [SESSION_ROW];
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
          durableConfigs.set(sessionId, applyEnvSyncDurableWrite(durableConfigs.get(sessionId) ?? null, patch.config));
        },
      }),
    }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionSecretGrant: async () => 'all' as const,
}));

mock.module('../secrets', () => ({
  ...realSecrets,
  listProjectSecretsSnapshotForUser: async () => {
    secretsReads += 1;
    return { env: { EXAMPLE: 'v' }, names: ['EXAMPLE'], revision: 'rev-1', capabilitiesJson: '{"version":1,"capabilities":[]}' };
  },
}));

mock.module('./network-secret-boundary', () => ({
  resolveSessionNetworkBoundary: async () => {
    boundaryReads += 1;
    if (boundaryResolveError) throw boundaryResolveError;
    return [];
  },
}));

mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
  envPushes += 1;
  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  return Response.json({ ok: true, revision: body.revision, exported: 1, managed: 1, withheld: 0, agent_env_written: true });
};

const { __resetNetworkBoundaryArmCacheForTests, __resetPromptModelSignatureCacheForTests, syncSandboxEnvForPrompt } =
  await import('./sandbox-env-sync');
const { prefetchPromptEnv, __resetPromptEnvPrefetchForTests, PROMPT_ENV_PREFETCH_TTL_MS } = await import(
  './sandbox-env-push'
);

function prompt(requestedAgent?: string | null) {
  return syncSandboxEnvForPrompt({
    projectId: 'proj-1',
    sessionId: 'sess-1',
    externalId: 'ext-1',
    serviceKey: 'svc-key',
    previewUrl: 'https://sandbox.test',
    providerHeaders: {},
    providerName: 'platinum',
    ...(requestedAgent !== undefined ? { requestedAgent } : {}),
  });
}

/** Let the prefetch's (mocked, immediate) reads settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  setSystemTime();
});

beforeEach(() => {
  (config as any).KORTIX_ENV_SYNC_MIN_INTERVAL_MS = 0;
  __resetNetworkBoundaryArmCacheForTests();
  __resetPromptModelSignatureCacheForTests();
  __resetPromptEnvPrefetchForTests();
  durableConfigs.clear();
  secretsReads = 0;
  boundaryReads = 0;
  envPushes = 0;
  person = 'user-1';
  boundaryResolveError = null;
  setSystemTime();
});

/** Prefetch, wait for its reads, then count only what the prompt itself reads. */
async function prefetched(agent: string | null = null) {
  prefetchPromptEnv('proj-1', 'sess-1', agent);
  await settle();
  const during = { secretsReads, boundaryReads };
  secretsReads = 0;
  boundaryReads = 0;
  return during;
}

describe('prefetchPromptEnv — the first prompt takes the reads made while the box booted', () => {
  test('a matching prefetch: the prompt makes no secret or boundary read of its own, and still pushes', async () => {
    const during = await prefetched(null);
    expect(during.secretsReads).toBeGreaterThan(0);
    expect(during.boundaryReads).toBe(1);
    await prompt();
    expect({ secretsReads, boundaryReads, envPushes }).toEqual({ secretsReads: 0, boundaryReads: 0, envPushes: 1 });
  });

  test('without a prefetch the same prompt reads everything after the box is ready (the cost removed)', async () => {
    await prompt();
    expect(secretsReads).toBeGreaterThan(0);
    expect(boundaryReads).toBe(1);
  });

  test('a prefetch for another agent is not used', async () => {
    await prefetched('other-agent');
    await prompt(null);
    expect(boundaryReads).toBe(1);
  });

  test('a prefetch read for another person is not used: no personal secrets cross people', async () => {
    await prefetched(null);
    person = 'user-2';
    await prompt();
    expect(boundaryReads).toBe(1);
    expect(secretsReads).toBeGreaterThan(0);
  });

  test('a prefetch that failed is not used; the prompt resolves afresh and succeeds', async () => {
    boundaryResolveError = new Error('boundary down');
    await prefetched(null);
    boundaryResolveError = null;
    await prompt();
    expect(boundaryReads).toBe(1);
    expect(envPushes).toBe(1);
  });

  test('a prefetch older than its TTL is not used', async () => {
    const start = new Date('2026-11-03T12:00:00Z');
    setSystemTime(start);
    await prefetched(null);
    setSystemTime(new Date(start.getTime() + PROMPT_ENV_PREFETCH_TTL_MS + 1));
    await prompt();
    expect(boundaryReads).toBe(1);
  });

  test('a prefetch serves one prompt only', async () => {
    await prefetched(null);
    await prompt();
    expect(boundaryReads).toBe(0);
    __resetPromptModelSignatureCacheForTests();
    await prompt();
    expect(boundaryReads).toBe(1);
  });
});
