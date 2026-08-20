// Which runtime a sandbox happens to be on decides NOTHING on the
// egress-enforced path any more.
//
// It used to decide everything: Platinum had a credential edge to arm, every
// other provider had none, and a session carrying a boundary secret on one of
// those failed provisioning outright unless the project carried the in-guest
// shim opt-in flag. One mechanism now serves all three
// (docs/specs/2026-08-19-secrets-exposure-usage-model.md §4) — the guest holds a
// HANDLE and the broker route substitutes the real value server-side — so the
// arm, the edge and the flag are gone.
//
// Every row runs against all three providers and every row must be identical. A
// table where two providers differ is the branch this file exists to keep
// deleted.
//
// The probe is the secret-CRUD fan-out rather than the prompt path, because the
// fan-out is the caller that does NOT fail soft — a refusal reaches its report
// verbatim, which is the only place the decision is observable as a message.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';
import type { ProviderName } from '../../platform/providers';
import type { NetworkBoundarySecretBinding } from '../../secrets/network-boundary';

/** Which provider the single active sandbox row reports for the case in flight. */
let sandboxProvider: ProviderName = 'daytona';
let envPushes: Array<{ url: string }> = [];

const SESSION_ROW = {
  createdBy: 'user-1',
  agentName: 'support',
  secretsAllowlist: null,
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  sessionId: 'sess-1',
  externalId: 'ext-1',
  config: { serviceKey: 'svc-key' },
};

// One fake row satisfies every select on this path: the sandbox lookup, the
// session lookup and the project lookup.
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = [{ ...SESSION_ROW, provider: sandboxProvider, metadata: null }];
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
  resolveSessionNetworkBoundary: async () => [
    {
      secretId: 'secret-1',
      identifier: 'billing-api',
      alias: 'KORTIX_secret1',
      hosts: ['api.example.com'],
    } satisfies NetworkBoundarySecretBinding,
  ],
}));

mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: string }) => {
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

const { __resetNetworkBoundaryArmCacheForTests, propagateProjectSecretsToActiveSandboxes } =
  await import('./sandbox-env-sync');

// The stub above is installed at module scope, so without this every file that
// runs after this one in the same process inherits it. That is the leak class
// this suite already gets bitten by; ORIGINAL_FETCH exists to be put back.
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  __resetNetworkBoundaryArmCacheForTests();
  envPushes = [];
  sandboxProvider = 'daytona';
});

const PROVIDERS: ProviderName[] = ['daytona', 'platinum', 'e2b'];

describe('egress-enforced delivery is provider-independent', () => {
  for (const provider of PROVIDERS) {
    test(`${provider}: delivers the snapshot with no provider call and no flag`, async () => {
      sandboxProvider = provider;

      const result = await propagateProjectSecretsToActiveSandboxes('proj-1');

      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('synced');
      expect(result.results[0].reason).toBeUndefined();
      // The env push is the delivery. Before the unification, daytona and e2b
      // never reached it: the arm refused first and the sandbox got nothing.
      expect(envPushes).toHaveLength(1);
    });
  }

  test('the three providers produce byte-identical outcomes', async () => {
    const outcomes: Array<{ provider: ProviderName; status: string; pushes: number }> = [];
    for (const provider of PROVIDERS) {
      __resetNetworkBoundaryArmCacheForTests();
      envPushes = [];
      sandboxProvider = provider;
      const result = await propagateProjectSecretsToActiveSandboxes('proj-1');
      outcomes.push({
        provider,
        status: result.results[0].status,
        pushes: envPushes.length,
      });
    }

    const shape = ({ provider: _provider, ...rest }: (typeof outcomes)[number]) => rest;
    expect(outcomes.map(shape)).toEqual([
      { status: 'synced', pushes: 1 },
      { status: 'synced', pushes: 1 },
      { status: 'synced', pushes: 1 },
    ]);
  });
});
