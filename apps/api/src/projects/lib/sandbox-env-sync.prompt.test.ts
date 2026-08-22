// An egress-enforced secret must never cost the user a turn.
//
// It did. `syncSandboxEnvForPrompt` re-armed the Platinum credential edge on
// EVERY prompt — re-reading the sandbox's secrets, re-checking each replica,
// re-attaching the same set, then polling up to 10s for `armed` — before the
// prompt could be forwarded. Measured on dev, same session, same sandbox, only
// the egress secret toggled: `POST /session/{id}/prompt_async` returned 502 in
// 5.2s with the secret active and 200 in 1.2s with it disabled. A project with
// one boundary secret could not run a single agent turn.
//
// The edge is gone (docs/specs/2026-08-19-secrets-exposure-usage-model.md §4),
// which removes the cost at the root. What still has to hold on this path, and
// is asserted here: the prompt reaches the daemon, an unchanged env is not
// re-pushed, and resolving the binding set stays FAIL-CLOSED — it re-reads the
// agent's grant, and a grant we cannot prove must refuse the turn.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { config } from '../../config';

import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';
import type { NetworkBoundarySecretBinding } from '../../secrets/network-boundary';

/** Everything the two paths do, in the order they did it. */
let events: string[] = [];
let envPushes: Array<{ url: string }> = [];
let bindings: NetworkBoundarySecretBinding[] = [];
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

// One fake row satisfies every select on this path: the session lookup, the
// project lookup, the gateway-mode lookup and the sandbox lookup.
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = [SESSION_ROW];
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
    env: { EXAMPLE: 'v' },
    names: ['EXAMPLE'],
    revision: 'rev-1',
    capabilitiesJson: '{"version":1,"capabilities":[]}',
  }),
}));

mock.module('./network-secret-boundary', () => ({
  resolveSessionNetworkBoundary: async () => {
    if (boundaryResolveError) throw boundaryResolveError;
    return bindings;
  },
}));

mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: string }) => {
  events.push('env-push');
  envPushes.push({ url: String(url) });
  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  return Response.json({
    ok: true,
    revision: body.revision,
    exported: Object.keys((body.env as Record<string, unknown> | undefined) ?? {}).length,
    managed: 1,
    withheld: 0,
    agent_env_written: true,
  });
};

const {
  __resetNetworkBoundaryArmCacheForTests,
  __resetPromptModelSignatureCacheForTests,
  propagateProjectSecretsToActiveSandboxes,
  syncSandboxEnvForPrompt,
} = await import('./sandbox-env-sync');

function binding(overrides: Partial<NetworkBoundarySecretBinding> = {}): NetworkBoundarySecretBinding {
  return {
    secretId: 'secret-1',
    identifier: 'billing-api',
    alias: 'KORTIX_secret1',
    hosts: ['api.example.com'],
    ...overrides,
  };
}

function prompt(externalId = 'ext-1') {
  return syncSandboxEnvForPrompt({
    projectId: 'proj-1',
    sessionId: 'sess-1',
    externalId,
    serviceKey: 'svc-key',
    previewUrl: 'https://sandbox.test',
    providerHeaders: {},
    providerName: 'platinum',
  });
}

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  // Sequential awaited propagates must run immediately in tests: the
  // production coalescer only exists to merge storm bursts (see
  // env-sync-coalescer.ts), and a cooling-down interval here would make
  // every second call in a case queue for the full window.
  (config as any).KORTIX_ENV_SYNC_MIN_INTERVAL_MS = 0;

  __resetNetworkBoundaryArmCacheForTests();
  __resetPromptModelSignatureCacheForTests();
  events = [];
  envPushes = [];
  bindings = [binding()];
  boundaryResolveError = null;
});

describe('syncSandboxEnvForPrompt — egress-enforced secrets', () => {
  test('a boundary secret never reaches a provider, and an unchanged env is pushed once', async () => {
    await prompt();
    await prompt();
    await prompt();

    // Identical env, same box, inside the push TTL: only the first prompt
    // reaches the daemon at all (see `PROMPT_ENV_PUSH_TTL_MS`).
    expect(envPushes).toHaveLength(1);
    // There is no provider step left on this path — no arm, no wait, no 502.
    expect(events).toEqual(['env-push']);
  });

  test('a changed binding set does not add a provider round-trip either', async () => {
    await prompt();
    bindings = [binding({ hosts: ['api.example.com', 'eu.example.com'] })];
    await prompt();
    bindings = [];
    await prompt();

    expect(events).toEqual(['env-push']);
  });

  test('the memo is per sandbox — a second box pushes on its own first prompt', async () => {
    await prompt('ext-1');
    await prompt('ext-2');
    await prompt('ext-1');

    expect(envPushes.map((push) => push.url)).toHaveLength(2);
  });

  test('an unresolvable binding set still fails the prompt closed', async () => {
    // Resolving the bindings re-reads the agent's grant, and a grant we cannot
    // prove must refuse the turn rather than push a snapshot built on a guess.
    boundaryResolveError = new Error('could not resolve the secrets grant');

    await expect(prompt()).rejects.toThrow('could not resolve the secrets grant');
    expect(envPushes).toEqual([]);
  });
});

describe('propagateProjectSecretsToActiveSandboxes — egress-enforced secrets', () => {
  test('the fan-out delivers the snapshot and reports the session synced', async () => {
    const result = await propagateProjectSecretsToActiveSandboxes('proj-1');

    expect(result).toMatchObject({
      ok: true,
      failed: 0,
      results: [{ session_id: 'sess-1', status: 'synced' }],
    });
    expect(envPushes).toHaveLength(1);
  });

  test('an unresolvable binding set is REPORTED here, never swallowed', async () => {
    // This is the path that delivers a rotated credential. Its caller shows the
    // outcome to the author who just saved the secret, so a failure has to be
    // visible there rather than logged and forgotten.
    boundaryResolveError = new Error('could not resolve the secrets grant');

    const result = await propagateProjectSecretsToActiveSandboxes('proj-1');

    expect(result).toMatchObject({
      ok: false,
      synced: 0,
      failed: 1,
      results: [{ session_id: 'sess-1', status: 'failed', reason: 'could not resolve the secrets grant' }],
    });
    expect(envPushes).toEqual([]);
  });
});
