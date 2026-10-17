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
/** The credit_accounts row getCreditAccount answers with; null = no row at all. */
let creditAccountRow: { tier: string | null } | null = { tier: 'free' };
/** Rows the stale-session sweep hands the tick; empty keeps every other test untouched. */
let staleRows: Array<typeof sandboxComputeSessions.$inferSelect> = [];
/** What claimComputeWindow answers; false keeps every other test untouched. */
let claimResult = false;
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
    return creditAccountRow;
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
    return claimResult;
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
  creditAccountRow = { tier: 'free' };
  staleRows = [];
  claimResult = false;
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

  test('a box opened outside a session keeps the plain ledger description', async () => {
    staleRows = [staleRow(null)];
    claimResult = true;

    await tickRunningComputeCharges();

    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]!.description).toBe('Sandbox compute · 2vCPU/4GB/20GB · 600s');
  });
});

describe('a failed compute settlement', () => {
  // 10 minutes of 2 vCPU / 4 GB / 20 GB: 600 s * ($0.109441 / 3600 s) = $0.01824.
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
    ['one hour of 2 vCPU / 4 GB / 20 GB', SPEC, 3600, 0.10944109589041096],
    ['one minute, with no minimum charge', SPEC, 60, 0.10944109589041096 / 60],
    ['twice the machine for twice the time', { cpuCores: 4, memoryGb: 8, diskGb: 40, gpuCount: 0 }, 7200, 4 * 0.10944109589041096],
  ])('%s', (_name, spec, seconds, cost) => {
    expect(calculateComputeCost(spec, seconds)).toBeCloseTo(cost, 8);
  });

  test.each(['e2b', 'platinum'] as const)('%s bills the one hosted customer rate', (provider) => {
    expect(calculateComputeCost(SPEC, 3600, provider)).toBeCloseTo(0.10944109589041096, 8);
  });
});

// Billing revamp (KRTX-1832): metering is observability and must behave the
// same in every environment. `KORTIX_BILLING_INTERNAL_ENABLED` gates CHARGING
// (wallet debits, admission holds, routes); it no longer gates the meter.
describe('charging off meters everywhere', () => {
  test.each([
    ['startComputeSession', () => metering.startComputeSession({ sandboxId: 'sb', accountId: 'acct', spec: SPEC })],
    ['reopenComputeForSandbox', () => metering.reopenComputeForSandbox('sb', 'acct')],
  ] as const)('%s opens a window with no credit_accounts row at all', async (_name, call) => {
    billingEnabled = false;
    creditAccountRow = null;

    expect(await call()).toBe('cs_inserted');
    expect(storageCalls).toContain('insertComputeSession');
  });

  test.each([
    ['pauseComputeSession', () => metering.pauseComputeSession('sb')],
    ['endComputeSession', () => metering.endComputeSession('sb')],
  ] as const)('%s closes the window without touching the wallet', async (_name, call) => {
    billingEnabled = false;
    creditAccountRow = null;
    openRows = [staleRow('sess-123')];
    claimResult = true;

    await call();

    expect(storageCalls).toContain('claimComputeWindow');
    expect(settleCalls).toHaveLength(0);
  });

  // `markComputeSessionAlive` stamps through `db` directly; the throwing `db`
  // proxy doubles as the tripwire that the path now REACHES the database
  // (before this change it returned early without touching storage).
  test('markComputeSessionAlive writes the liveness stamp', async () => {
    billingEnabled = false;

    await expect(metering.markComputeSessionAlive('sb')).rejects.toThrow('the database was reached');
    expect(storageCalls).toContain('db');
  });

  test('the tick accrues the claimed window without a wallet debit', async () => {
    billingEnabled = false;
    creditAccountRow = null;
    staleRows = [staleRow('sess-123')];
    claimResult = true;

    expect(await tickRunningComputeCharges()).toEqual({ settled: 1, reconciled: 0 });

    expect(storageCalls).toContain('claimComputeWindow');
    expect(settleCalls).toHaveLength(0);
  });
});

describe('charging on keeps the account rule', () => {
  test('no credit_accounts row never meters compute', async () => {
    billingEnabled = true;
    creditAccountRow = null;

    expect(await metering.startComputeSession({ sandboxId: 'sb', accountId: 'acct', spec: SPEC })).toBeNull();
    expect(storageCalls).toEqual(['getCreditAccount']);
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
