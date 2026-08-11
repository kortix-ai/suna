// A network-boundary secret must never cost the user a turn.
//
// It did. `syncSandboxEnvForPrompt` re-armed the provider edge on EVERY prompt —
// re-reading the sandbox's secrets, re-checking each replica, re-attaching the
// same set, then polling up to 10s for `armed` — before the prompt could be
// forwarded. Measured on dev, same session, same sandbox, only the egress secret
// toggled: `POST /session/{id}/prompt_async` returned 502 in 5.2s with the secret
// active and 200 in 1.2s with it disabled. A project with one boundary secret
// could not run a single agent turn.
//
// Two properties close it, and both are asserted here: an unchanged desired set
// does not call the provider at all, and a provider failure never fails the turn.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realProviders from '../../platform/providers';
import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';
import type { NetworkBoundarySecretBinding } from '../../secrets/network-boundary';

/** Everything the two paths do, in the order they did it. */
let events: string[] = [];
let armCalls: Array<{ externalId: string; bindings: NetworkBoundarySecretBinding[] }> = [];
let envPushes: Array<{ url: string }> = [];
let armBehavior: 'ok' | 'throw' | 'hang' = 'ok';
/** Held open by `armBehavior: 'hang'` until a case decides the arm may finish.
 *  Created before every case so `openArmGate()` is safe to call at any moment,
 *  including before the provider call has actually started. */
let armGate = Promise.resolve();
let openArmGate: () => void = () => {};
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

// `shouldSyncProviderNetworkBoundary` stays REAL — the platinum-is-authoritative
// rule is part of what these cases exercise.
mock.module('../../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    syncNetworkBoundary: async (
      externalId: string,
      requested: NetworkBoundarySecretBinding[],
    ) => {
      events.push('boundary');
      armCalls.push({ externalId, bindings: requested });
      if (armBehavior === 'throw') throw new Error('platinum arm exploded');
      if (armBehavior === 'hang') await armGate;
      return { state: 'armed' as const, attached: requested.length };
    },
  }),
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
  propagateProjectSecretsToActiveSandboxes,
  syncSandboxEnvForPrompt,
} = await import('./sandbox-env-sync');

function binding(overrides: Partial<NetworkBoundarySecretBinding> = {}): NetworkBoundarySecretBinding {
  return {
    secretId: 'secret-1',
    identifier: 'billing-api',
    alias: 'KORTIX_secret1',
    hosts: ['api.example.com'],
    header: 'authorization',
    value: 'Bearer first-value',
    onEcho: 'block',
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
  __resetNetworkBoundaryArmCacheForTests();
  events = [];
  armCalls = [];
  envPushes = [];
  armBehavior = 'ok';
  armGate = new Promise<void>((resolve) => {
    openArmGate = resolve;
  });
  bindings = [binding()];
  boundaryResolveError = null;
});

describe('syncSandboxEnvForPrompt — network boundary', () => {
  test('arms once, then skips the provider while the desired set is unchanged', async () => {
    await prompt();
    await prompt();
    await prompt();

    expect(armCalls).toHaveLength(1);
    expect(envPushes).toHaveLength(3);
  });

  test('a rotated credential re-arms — the new value must reach the edge', async () => {
    await prompt();
    bindings = [binding({ value: 'Bearer rotated-value' })];
    await prompt();

    expect(armCalls).toHaveLength(2);
    expect(armCalls[1].bindings[0].value).toBe('Bearer rotated-value');
  });

  test('a changed policy re-arms — host, header and echo mode all count', async () => {
    await prompt();
    bindings = [binding({ hosts: ['api.example.com', 'eu.example.com'] })];
    await prompt();
    bindings = [binding({ header: 'x-api-key' })];
    await prompt();
    bindings = [binding({ alias: 'KORTIX_renamed' })];
    await prompt();

    expect(armCalls).toHaveLength(4);
  });

  test('removing the last binding re-arms so the edge stops holding the credential', async () => {
    await prompt();
    bindings = [];
    await prompt();
    await prompt();

    expect(armCalls).toHaveLength(2);
    expect(armCalls[1].bindings).toEqual([]);
  });

  test('two prompts racing on one sandbox share a single arm', async () => {
    // Two overlapping PUTs at the provider are last-write-wins, so an identical
    // desired set must join the arm already in flight rather than start another.
    armBehavior = 'hang';
    const first = prompt();
    const second = prompt();
    // Hold the arm long enough for BOTH turns to reach it, so the second one
    // genuinely joins the in-flight call instead of finding a finished memo.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    openArmGate();
    await Promise.all([first, second]);

    expect(armCalls).toHaveLength(1);
    expect(events).toEqual(['boundary', 'env-push', 'env-push']);
  });

  test('a provider that needs no boundary call is never called for an empty set', async () => {
    // Daytona is on-demand: zero bindings means nothing to arm and nothing stale
    // to erase. Platinum is authoritative and still gets the erase (asserted
    // above), so this is the policy split, not a shortcut.
    bindings = [];
    await syncSandboxEnvForPrompt({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      externalId: 'ext-daytona',
      serviceKey: 'svc-key',
      previewUrl: 'https://sandbox.test',
      providerHeaders: {},
      providerName: 'daytona',
    });

    expect(armCalls).toEqual([]);
    expect(envPushes).toHaveLength(1);
  });

  test('the memo is per sandbox — a second box arms on its own first prompt', async () => {
    await prompt('ext-1');
    await prompt('ext-2');
    await prompt('ext-1');

    expect(armCalls.map((call) => call.externalId)).toEqual(['ext-1', 'ext-2']);
  });

  test('a provider failure logs and the turn still runs', async () => {
    armBehavior = 'throw';

    await prompt();

    expect(events).toEqual(['boundary', 'env-push']);
    expect(envPushes).toHaveLength(1);
  });

  test('a failed arm is not remembered as armed — the next prompt retries it', async () => {
    armBehavior = 'throw';
    await prompt();
    armBehavior = 'ok';
    await prompt();

    expect(armCalls).toHaveLength(2);
    expect(events).toEqual(['boundary', 'env-push', 'boundary', 'env-push']);
  });

  test('a slow arm does not hold the turn, and its result still lands', async () => {
    armBehavior = 'hang';

    const startedAt = Date.now();
    await prompt();
    const elapsedMs = Date.now() - startedAt;

    // Bounded by PROMPT_BOUNDARY_ARM_WAIT_MS (1500ms), not by the provider's own
    // 10s arm budget — the 502 this whole change exists to remove.
    expect(elapsedMs).toBeLessThan(3_000);
    expect(envPushes).toHaveLength(1);

    // The arm was never abandoned: let it finish and the memo records it, so the
    // next prompt skips instead of re-arming.
    openArmGate();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    armBehavior = 'ok';
    await prompt();
    expect(armCalls).toHaveLength(1);
  });

  test('the boundary is armed BEFORE the env push, always', async () => {
    await prompt();
    bindings = [binding({ value: 'Bearer rotated-value' })];
    await prompt();

    expect(events).toEqual(['boundary', 'env-push', 'boundary', 'env-push']);
  });

  test('an unresolvable binding set still fails the prompt closed', async () => {
    // The fail-soft covers provider ARMING only. Resolving the bindings re-reads
    // the agent's grant, and a grant we cannot prove must refuse the turn.
    boundaryResolveError = new Error('could not resolve the secrets grant');

    await expect(prompt()).rejects.toThrow('could not resolve the secrets grant');
    expect(envPushes).toEqual([]);
  });
});

describe('propagateProjectSecretsToActiveSandboxes — network boundary', () => {
  test('an arming failure is REPORTED here, never swallowed', async () => {
    // The secret-CRUD fan-out is the path that delivers a rotated credential.
    // Its caller shows the outcome to the author who just saved the secret, so
    // the prompt path's fail-soft must not reach it.
    armBehavior = 'throw';

    const result = await propagateProjectSecretsToActiveSandboxes('proj-1');

    expect(result).toMatchObject({
      ok: false,
      synced: 0,
      failed: 1,
      results: [{ session_id: 'sess-1', status: 'failed', reason: 'platinum arm exploded' }],
    });
    expect(envPushes).toEqual([]);
  });

  test('the fan-out shares the memo: an unchanged set is not re-armed', async () => {
    await prompt();
    const result = await propagateProjectSecretsToActiveSandboxes('proj-1');

    expect(result.ok).toBe(true);
    expect(armCalls).toHaveLength(1);
  });
});
