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
/** Rows the stale-session sweep hands the tick; empty keeps every other test untouched. */
let staleRows: Array<typeof sandboxComputeSessions.$inferSelect> = [];
/** What claimComputeWindow answers; false keeps every other test untouched. */
let claimResult = false;
/** The claim arguments, so a test can assert the cursor and the claimed cost. */
let claimCalls: Array<Record<string, unknown>> = [];
/** The session's first turn instant the repository read answers. Defaults to a
 *  long-past instant so every session row reads as already-in-use; a null
 *  answer is the empty-session state the first-turn guard forgives. */
let firstTurnAnswer: Date | null = new Date(0);
/** Wallet settlements the metering path attempted (the real wallet is never reached). */
let settleCalls: Array<{ description: string } & Record<string, unknown>> = [];

mock.module('./wallet-debits', () => ({
  settleAndCheckAutoTopup: async (
    input: { description: string } & Record<string, unknown>,
  ) => {
    settleCalls.push(input);
    if (settleError) throw settleError;
    return { amount: input.amount, balance: 0, overdraft: false, transactionId: 'tx_test', replayed: false };
  },
}));

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
  claimComputeWindow: async (input: Record<string, unknown>) => {
    storageCalls.push('claimComputeWindow');
    claimCalls.push(input);
    return claimResult;
  },
  firstSessionTurnStartedAt: async (sessionId: string) => {
    storageCalls.push(`firstSessionTurnStartedAt:${sessionId}`);
    return firstTurnAnswer;
  },
  releaseComputeWindow: async () => {
    storageCalls.push('releaseComputeWindow');
    return false;
  },
  findStaleActiveSessions: async () => {
    storageCalls.push('findStaleActiveSessions');
    return staleRows;
  },
}));

/** Whether the ledger holds the debit key after a failed settle. */
let ledgerHasKey = false;
let settleError: Error | null = null;
mock.module('../repositories/ledger-keys', () => ({
  ledgerRequestKeyExists: async () => ledgerHasKey,
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

import { sandboxComputeSessions } from '@kortix/db';

const metering = await import('./compute-metering');
const { calculateComputeCost, tickRunningComputeCharges } = metering;

const SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

beforeEach(() => {
  billingEnabled = true;
  storageCalls = [];
  openRows = [];
  insertError = null;
  staleRows = [];
  claimResult = false;
  claimCalls = [];
  firstTurnAnswer = new Date(0);
  settleCalls = [];
  ledgerHasKey = false;
  settleError = null;
});

/** An active sandbox row the tick would settle this pass, 10 minutes unbilled. */
function staleRow(sessionId: string | null): typeof sandboxComputeSessions.$inferSelect {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const now = new Date().toISOString();
  return {
    id: 'cs_row',
    accountId: 'acct_tick_' + Math.random().toString(36).slice(2),
    sandboxId: 'sb_row',
    sessionId,
    actorUserId: null,
    provider: 'daytona',
    cpuCores: 2,
    memoryGb: 4,
    diskGb: 20,
    gpuCount: 0,
    state: 'active',
    startedAt: tenMinutesAgo,
    endedAt: null,
    lastBilledAt: tenMinutesAgo,
    costUsd: '0',
    ledgerId: null,
    metadata: { lastAliveAt: now },
    workloadType: 'session',
    appRuntimeId: null,
    createdAt: tenMinutesAgo,
    updatedAt: tenMinutesAgo,
  };
}

describe('the partial-billing tick', () => {
  test('the settle names the session that ran the box in the ledger debit', async () => {
    staleRows = [staleRow('sess-123')];
    claimResult = true;

    const result = await tickRunningComputeCharges();

    expect(result.settled).toBe(1);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]!.description).toBe('Sandbox compute · sess-123 · 2vCPU/4GB/20GB · 600s');
  });

  test('a zero-message session bills nothing and still advances the cursor', async () => {
    // KRTX-1546: a session that never accepted a turn (a warm session waiting
    // for a send that never came) must not debit the wallet for the idle its
    // box ran. The cursor still moves, so the elapsed idle is forgiven as it
    // elapses instead of retro-billing when the first turn lands.
    staleRows = [staleRow('sess-empty')];
    claimResult = true;
    firstTurnAnswer = null;

    const result = await tickRunningComputeCharges();

    expect(result.settled).toBe(1);
    expect(settleCalls).toEqual([]);
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]!['addCostUsd']).toBe(0);
    expect(claimCalls[0]!['expectedLastBilledAt']).toBe(staleRows[0]!.lastBilledAt);
    expect(claimCalls[0]!['nextLastBilledAt']).not.toBe(staleRows[0]!.lastBilledAt);
  });

  test('a session whose first turn falls inside the window bills only from the turn', async () => {
    // The cursor sits ten minutes back; the first turn landed five minutes
    // into that window. The pre-turn idle is forgiven, the post-turn work bills.
    staleRows = [staleRow('sess-midwindow')];
    claimResult = true;
    firstTurnAnswer = new Date(Date.parse(staleRows[0]!.lastBilledAt) + 5 * 60_000);

    const result = await tickRunningComputeCharges();

    expect(result.settled).toBe(1);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]!.description).toBe('Sandbox compute · sess-midwindow · 2vCPU/4GB/20GB · 300s');
    // Half the window's cost: the pre-turn half is forgiven, not deferred.
    expect(settleCalls[0]!['amount']).toBeGreaterThan(0);
    expect(settleCalls[0]!['amount']).toBeLessThan(0.201312 / 6);
  });

  test('a session whose first turn predates the cursor bills its whole window', async () => {
    staleRows = [staleRow('sess-used')];
    claimResult = true;
    firstTurnAnswer = new Date(0);

    await tickRunningComputeCharges();

    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]!.description).toBe('Sandbox compute · sess-used · 2vCPU/4GB/20GB · 600s');
  });

  test('a box opened outside a session keeps the plain ledger description', async () => {
    staleRows = [staleRow(null)];
    claimResult = true;

    await tickRunningComputeCharges();

    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]!.description).toBe('Sandbox compute · 2vCPU/4GB/20GB · 600s');
  });
});

describe('a failed compute settlement', () => {
  // 10 minutes of 2 vCPU / 4 GB / 20 GB: 600 s * ($0.201312 / 3600 s) = $0.03355.
  test('releases the window when the ledger holds no debit under the key', async () => {
    staleRows = [staleRow('sess-123')];
    claimResult = true;
    settleError = new Error('connection terminated');
    ledgerHasKey = false;

    await tickRunningComputeCharges();

    expect(storageCalls).toContain('releaseComputeWindow');
  });

  test('keeps the window when the debit committed and only the response was lost', async () => {
    staleRows = [staleRow('sess-123')];
    claimResult = true;
    settleError = new Error('connection terminated');
    ledgerHasKey = true;

    await tickRunningComputeCharges();

    expect(settleCalls).toHaveLength(1);
    expect(storageCalls).not.toContain('releaseComputeWindow');
  });
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
