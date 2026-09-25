// What compute metering does without a database: its price, its self-host
// gates, and its recovery from a concurrent open. Every database-backed
// behaviour (windows, candidate SQL, ledger debits) runs on PostgreSQL in
// compute-metering.integration.test.ts and
// ../repositories/compute-sessions.integration.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let billingEnabled = true;

// The other config exports must be listed explicitly: a partial namespace makes
// ESM named-export resolution fail for any sibling test file that imports them
// in the same run.
mock.module('../../config', () => ({
  SANDBOX_VERSION: '0.0.0-test',
  KNOWN_PROVIDERS: [],
  KORTIX_MARKUP: 1,
  PLATFORM_FEE_MARKUP: 1,
  getToolCost: () => 0,
  parseAllowedProviders: () => [],
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return billingEnabled;
        return target[key];
      },
    },
  ),
}));

/** Every storage call the service made, by name. */
let storageCalls: string[] = [];
let openRows: Array<{ id: string } | null> = [];
let insertError: unknown = null;

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => {
    storageCalls.push('getCreditAccount');
    return { billingModel: 'per_seat', tier: 'free' };
  },
  getCreditBalance: async () => null,
  updateCreditAccount: async () => undefined,
  getSubscriptionInfo: async () => null,
}));

mock.module('../repositories/compute-sessions', () => ({
  insertComputeSession: async () => {
    storageCalls.push('insertComputeSession');
    if (insertError) throw insertError;
    return { id: 'cs_inserted' };
  },
  getOpenComputeSession: async () => {
    storageCalls.push('getOpenComputeSession');
    return openRows.shift() ?? null;
  },
  getLatestComputeSession: async () => {
    storageCalls.push('getLatestComputeSession');
    return null;
  },
  claimComputeWindow: async () => {
    storageCalls.push('claimComputeWindow');
    return false;
  },
  releaseComputeWindow: async () => {
    storageCalls.push('releaseComputeWindow');
    return false;
  },
  findStaleActiveSessions: async () => {
    storageCalls.push('findStaleActiveSessions');
    return [];
  },
}));

mock.module('../../shared/db', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        storageCalls.push('db');
        throw new Error('the database was reached');
      },
    },
  ),
}));

const metering = await import('./compute-metering');
const { calculateComputeCost } = metering;

const SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

beforeEach(() => {
  billingEnabled = true;
  storageCalls = [];
  openRows = [];
  insertError = null;
});

describe('calculateComputeCost', () => {
  test.each([
    ['a zero-length window', SPEC, 0, 0],
    ['a negative window', SPEC, -5, 0],
    ['one hour of 2 vCPU / 4 GB / 20 GB', SPEC, 3600, 0.201312],
    ['one minute, with no minimum charge', SPEC, 60, 0.201312 / 60],
    ['twice the machine for twice the time', { cpuCores: 4, memoryGb: 8, diskGb: 40, gpuCount: 0 }, 7200, 0.805248],
  ])('%s', (_name, spec, seconds, cost) => {
    expect(calculateComputeCost(spec, seconds)).toBeCloseTo(cost, 8);
  });

  test.each(['e2b', 'platinum'] as const)('%s bills the one hosted customer rate', (provider) => {
    expect(calculateComputeCost(SPEC, 3600, provider)).toBeCloseTo(0.201312, 8);
  });
});

describe('a self-hosted deployment never meters compute', () => {
  test.each([
    ['startComputeSession', () => metering.startComputeSession({ sandboxId: 'sb', accountId: 'acct', spec: SPEC }), null],
    ['reopenComputeForSandbox', () => metering.reopenComputeForSandbox('sb', 'acct'), null],
    ['pauseComputeSession', () => metering.pauseComputeSession('sb'), undefined],
    ['endComputeSession', () => metering.endComputeSession('sb'), undefined],
    ['markComputeSessionAlive', () => metering.markComputeSessionAlive('sb'), undefined],
    ['reconcileMissingComputeSessions', () => metering.reconcileMissingComputeSessions(), { checked: 0, reconciled: 0, errors: 0 }],
    ['reconcileMissingAppComputeSessions', () => metering.reconcileMissingAppComputeSessions(), { checked: 0, reconciled: 0, errors: 0 }],
    ['tickRunningComputeCharges', () => metering.tickRunningComputeCharges(), { settled: 0, reconciled: 0 }],
  ] as const)('%s returns without reading storage', async (_name, call, expected) => {
    billingEnabled = false;
    expect(await call()).toEqual(expected);
    expect(storageCalls).toEqual([]);
  });
});

describe('startComputeSession', () => {
  // `uniq_sandbox_compute_sessions_one_open`: a concurrent start opened the row
  // between the read and the insert. The loser returns the winner's row. Real
  // PostgreSQL cannot interleave that race on demand; the index and the wrapped
  // driver error are proven in compute-sessions.integration.test.ts.
  test('a start that loses the open race returns the winning window', async () => {
    openRows = [null, { id: 'cs_winner' }];
    insertError = Object.assign(new Error('Failed query: insert into sandbox_compute_sessions'), {
      cause: { code: '23505', constraint_name: 'uniq_sandbox_compute_sessions_one_open' },
    });

    expect(await metering.startComputeSession({ sandboxId: 'sb', accountId: 'acct', spec: SPEC })).toBe('cs_winner');
  });

  test('any other insert failure propagates', async () => {
    insertError = Object.assign(new Error('Failed query'), { cause: { code: '23502' } });

    await expect(metering.startComputeSession({ sandboxId: 'sb', accountId: 'acct', spec: SPEC })).rejects.toThrow(
      'Failed query',
    );
  });
});
