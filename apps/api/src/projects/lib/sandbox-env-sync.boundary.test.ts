// Which runtime a sandbox happens to be on decides exactly one thing on the
// network-boundary path: whether there is a provider edge to arm before the
// credential can be spent. `startNetworkBoundaryArm` is where that is decided,
// and it decides it by asking the provider object for a `syncNetworkBoundary`
// — never by provider name. When there is none the credential is injected by
// the broker route at request time instead, so the arm has nothing to register
// and skipping it is correct; until that was true, creating a session with a
// boundary secret on a shim provider failed provisioning outright.
//
// Every row runs against all three providers. Daytona and e2b are the same
// expectation twice on purpose: neither implements a provider edge, so a row
// where those two differ is a bug in the decision, not a difference between the
// runtimes.
//
// The probe is the secret-CRUD fan-out rather than the prompt path, because the
// fan-out is the caller that does NOT fail soft — a refusal reaches its report
// verbatim, which is the only place the decision is observable as a message.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realProviders from '../../platform/providers';
import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';
import type { ProviderName } from '../../platform/providers';
import type { NetworkBoundarySecretBinding } from '../../secrets/network-boundary';

/** Which provider the single active sandbox row reports for the case in flight. */
let sandboxProvider: ProviderName = 'daytona';
/** Project-level `network_boundary_shim`, resolved through the real registry. */
let shimFlag = false;
let armCalls: Array<{ provider: string; externalId: string }> = [];
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
// session lookup, the project lookup, and the flag lookup that
// `projectFeatureFlagEnabled` performs — which is left REAL so the flag is
// resolved by the registry that ships, not by a stand-in that could disagree
// with it about the default.
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = [
            {
              ...SESSION_ROW,
              provider: sandboxProvider,
              metadata: shimFlag ? { experimental: { network_boundary_shim: true } } : null,
            },
          ];
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
      header: 'authorization',
      value: 'Bearer value',
      onEcho: 'block',
    } satisfies NetworkBoundarySecretBinding,
  ],
}));

mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

/** Providers whose runtime object carries a provider edge to arm. */
const PROVIDER_EDGE: Record<ProviderName, boolean> = {
  daytona: false,
  platinum: true,
  e2b: false,
};

// `shouldSyncProviderNetworkBoundary` stays REAL — the authoritative-vs-on-demand
// split is upstream of the decision under test and must not be stubbed out.
mock.module('../../platform/providers', () => ({
  ...realProviders,
  getProvider: (name: ProviderName) =>
    PROVIDER_EDGE[name]
      ? {
          name,
          syncNetworkBoundary: async (
            externalId: string,
            requested: NetworkBoundarySecretBinding[],
          ) => {
            armCalls.push({ provider: name, externalId });
            return { state: 'armed' as const, attached: requested.length };
          },
        }
      : // No `syncNetworkBoundary` key at all — the shape every provider but
        // Platinum actually has, since the method is optional on the interface.
        { name },
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
  armCalls = [];
  envPushes = [];
  sandboxProvider = 'daytona';
  shimFlag = false;
});

interface ArmCase {
  provider: ProviderName;
  shimFlag: boolean;
  what: string;
  status: 'synced' | 'failed';
  /** The refusal must say WHICH provider cannot deliver, so the message is
   *  derived from the provider under test rather than written per row. */
  refusalNamesProvider?: true;
  armCalls: number;
  envPushes: number;
}

const CASES: ArmCase[] = [
  {
    provider: 'daytona',
    shimFlag: false,
    what: 'refuses the delivery and names the provider',
    status: 'failed',
    refusalNamesProvider: true,
    armCalls: 0,
    envPushes: 0,
  },
  {
    provider: 'e2b',
    shimFlag: false,
    what: 'refuses the delivery and names the provider',
    status: 'failed',
    refusalNamesProvider: true,
    armCalls: 0,
    envPushes: 0,
  },
  {
    provider: 'platinum',
    shimFlag: false,
    what: 'arms the provider edge, which needs no flag',
    status: 'synced',
    armCalls: 1,
    envPushes: 1,
  },
  {
    provider: 'daytona',
    shimFlag: true,
    what: 'treats the missing edge as nothing to do',
    status: 'synced',
    armCalls: 0,
    envPushes: 1,
  },
  {
    provider: 'e2b',
    shimFlag: true,
    what: 'treats the missing edge as nothing to do',
    status: 'synced',
    armCalls: 0,
    envPushes: 1,
  },
  {
    provider: 'platinum',
    shimFlag: true,
    what: 'still arms the provider edge — the shim flag does not divert it',
    status: 'synced',
    armCalls: 1,
    envPushes: 1,
  },
];

describe('network-boundary arm decision', () => {
  for (const testCase of CASES) {
    test(`${testCase.provider}, shim flag ${testCase.shimFlag ? 'on' : 'off'}: ${testCase.what}`, async () => {
      sandboxProvider = testCase.provider;
      shimFlag = testCase.shimFlag;

      const result = await propagateProjectSecretsToActiveSandboxes('proj-1');

      expect(result.ok).toBe(testCase.status === 'synced');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe(testCase.status);
      if (testCase.refusalNamesProvider) {
        expect(result.results[0].reason).toBe(
          `Sandbox provider ${testCase.provider} does not support network-boundary secret delivery`,
        );
      } else {
        expect(result.results[0].reason).toBeUndefined();
      }
      expect(armCalls).toEqual(
        Array.from({ length: testCase.armCalls }, () => ({
          provider: testCase.provider,
          externalId: 'ext-1',
        })),
      );
      // A refusal must stop before the env push: the sandbox never receives a
      // snapshot that implies a credential the edge is not holding.
      expect(envPushes).toHaveLength(testCase.envPushes);
    });
  }

  test('the shim providers agree with each other in every row', () => {
    // The guard the table exists for. Daytona is proven live and e2b runs the
    // identical code, so the two columns must stay indistinguishable; a row
    // added for one of them and not the other is the drift this catches.
    const shimRows = (provider: ProviderName) =>
      CASES.filter((row) => row.provider === provider).map(
        ({ provider: _provider, ...rest }) => rest,
      );

    expect(shimRows('e2b')).toEqual(shimRows('daytona'));
  });
});
