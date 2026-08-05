import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realProviders from '../../platform/providers';

let billingEnabled = true;

// The other config exports must be listed explicitly: a partial namespace makes
// ESM named-export resolution fail for any sibling test file that imports them
// in the same run (SANDBOX_VERSION was breaking the whole billing/services suite).
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
        if (Object.hasOwn(target, key)) return target[key];
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return billingEnabled;
        return target[key];
      },
    },
  ),
}));

let accountsById: Record<string, { billingModel: string } | undefined> = {};
let throwForAccountIds = new Set<string>();

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async (accountId: string) => {
    if (throwForAccountIds.has(accountId)) throw new Error('credit account lookup failed');
    return accountsById[accountId] ?? null;
  },
  getCreditBalance: async () => null,
  updateCreditAccount: async () => undefined,
  getSubscriptionInfo: async () => null,
}));

mock.module('./credits', () => ({
  deductCredits: async () => {},
}));

interface FakeComputeRow {
  id: string;
  accountId: string;
  sandboxId: string;
  sessionId: string | null;
  provider: string;
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
  gpuCount: number;
  state: string;
  costUsd: string;
  lastBilledAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  endedAt: string | null;
}

let computeRows: FakeComputeRow[] = [];
let insertCalls = 0;
let nextId = 1;

function openRowFor(sandboxId: string): FakeComputeRow | null {
  return computeRows.find((r) => r.sandboxId === sandboxId && r.endedAt === null) ?? null;
}

mock.module('../repositories/compute-sessions', () => ({
  insertComputeSession: async (data: Record<string, unknown>) => {
    insertCalls += 1;
    const row: FakeComputeRow = {
      id: `row-${nextId++}`,
      endedAt: null,
      costUsd: '0',
      lastBilledAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      ...data,
    } as FakeComputeRow;
    computeRows.push(row);
    return row;
  },
  getOpenComputeSession: async (sandboxId: string) => openRowFor(sandboxId),
  getLatestComputeSession: async (sandboxId: string) => {
    const rows = computeRows.filter((r) => r.sandboxId === sandboxId);
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  },
  updateComputeSession: async () => {},
  findStaleActiveSessions: async () => [],
}));

interface FakeSandboxRow {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  provider: string;
  status: string;
  externalId?: string | null;
}

let sandboxRows: FakeSandboxRow[] = [];
let providerStatusById: Record<string, string> = {};

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../platform/providers', () => ({
  ...realProviders,
  // 60 minutes — the provider's own idle auto-stop, which is also the ceiling on
  // how long a compute window may bill past its last liveness observation
  // (services/compute-liveness.ts).
  providerAutoStopBackstopMinutes: () => 60,
  getProvider: () => ({
    getStatus: async (externalId: string) => providerStatusById[externalId] ?? 'running',
  }),
}));

const selectMissing = async (limit: number) =>
  sandboxRows
    .filter(
      (r) =>
        r.status === 'active' &&
        !openRowFor(r.sandboxId) &&
        accountsById[r.accountId]?.billingModel === 'per_seat',
    )
    .slice(0, limit)
    .map((r) => ({
      sandboxId: r.sandboxId,
      sessionId: r.sessionId,
      accountId: r.accountId,
      provider: r.provider,
      externalId: r.externalId ?? `ext-${r.sandboxId}`,
    }));

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        // Mirrors the real query shape: inner join credit_accounts (per_seat only),
        // left join open compute rows, filter to active. The predicate itself is
        // asserted against rendered SQL in compute-metering-query.test.ts; this
        // fake only needs to feed the loop realistic rows.
        innerJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              // The sweep orders oldest-sandbox-first before limiting, so an
              // unordered LIMIT can't crowd the same rows out of every batch.
              orderBy: () => ({ limit: selectMissing }),
              limit: selectMissing,
            }),
          }),
        }),
      }),
    }),
  },
}));

const { reconcileMissingComputeSessions, tickRunningComputeCharges } = await import(
  './compute-metering'
);

beforeEach(() => {
  billingEnabled = true;
  accountsById = {};
  throwForAccountIds = new Set();
  computeRows = [];
  providerStatusById = {};
  sandboxRows = [];
  insertCalls = 0;
  nextId = 1;
});

function sandbox(overrides: Partial<FakeSandboxRow> = {}): FakeSandboxRow {
  return {
    sandboxId: 'sb-1',
    sessionId: 'sb-1',
    accountId: 'acct-1',
    provider: 'daytona',
    status: 'active',
    ...overrides,
  };
}

describe('reconcileMissingComputeSessions', () => {
  test('opens a compute window for a per-seat active sandbox with no open row', async () => {
    accountsById['acct-ps'] = { billingModel: 'per_seat' };
    sandboxRows = [sandbox({ sandboxId: 'sb-ps', sessionId: 'sb-ps', accountId: 'acct-ps' })];

    const result = await reconcileMissingComputeSessions();

    expect(result).toEqual({ checked: 1, reconciled: 1, errors: 0 });
    expect(openRowFor('sb-ps')).not.toBeNull();
  });

  test('never opens a compute window for a legacy-model account', async () => {
    accountsById['acct-legacy'] = { billingModel: 'legacy' };
    sandboxRows = [
      sandbox({ sandboxId: 'sb-legacy', sessionId: 'sb-legacy', accountId: 'acct-legacy' }),
    ];

    const result = await reconcileMissingComputeSessions();

    expect(result).toEqual({ checked: 0, reconciled: 0, errors: 0 });
    expect(openRowFor('sb-legacy')).toBeNull();
    expect(insertCalls).toBe(0);
  });

  test('is idempotent — a second pass does not open a duplicate row', async () => {
    accountsById['acct-ps'] = { billingModel: 'per_seat' };
    sandboxRows = [sandbox({ sandboxId: 'sb-dup', sessionId: 'sb-dup', accountId: 'acct-ps' })];

    const first = await reconcileMissingComputeSessions();
    expect(first.reconciled).toBe(1);

    const second = await reconcileMissingComputeSessions();
    expect(second).toEqual({ checked: 0, reconciled: 0, errors: 0 });
    expect(computeRows.filter((r) => r.sandboxId === 'sb-dup').length).toBe(1);
    expect(insertCalls).toBe(1);
  });

  test('leaves a stopped sandbox untouched', async () => {
    accountsById['acct-ps'] = { billingModel: 'per_seat' };
    sandboxRows = [
      sandbox({ sandboxId: 'sb-stopped', sessionId: 'sb-stopped', accountId: 'acct-ps', status: 'stopped' }),
    ];

    const result = await reconcileMissingComputeSessions();

    expect(result).toEqual({ checked: 0, reconciled: 0, errors: 0 });
    expect(computeRows.length).toBe(0);
  });

  test('reuses the last known spec instead of resetting to the default', async () => {
    accountsById['acct-ps'] = { billingModel: 'per_seat' };
    computeRows.push({
      id: 'row-old',
      accountId: 'acct-ps',
      sandboxId: 'sb-resume',
      sessionId: 'sb-resume',
      provider: 'daytona',
      cpuCores: 8,
      memoryGb: 16,
      diskGb: 100,
      gpuCount: 0,
      state: 'stopped',
      costUsd: '1.23',
      lastBilledAt: new Date().toISOString(),
      metadata: {},
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
    });
    sandboxRows = [
      sandbox({ sandboxId: 'sb-resume', sessionId: 'sb-resume', accountId: 'acct-ps' }),
    ];

    await reconcileMissingComputeSessions();

    const opened = openRowFor('sb-resume');
    expect(opened?.cpuCores).toBe(8);
    expect(opened?.memoryGb).toBe(16);
    expect(opened?.diskGb).toBe(100);
  });

  test('a lookup failure for one sandbox does not stop the rest of the pass', async () => {
    accountsById['acct-ps'] = { billingModel: 'per_seat' };
    // per_seat so it survives the SQL filter and reaches the loop, where the
    // per-row lookup is what throws.
    accountsById['acct-throws'] = { billingModel: 'per_seat' };
    throwForAccountIds.add('acct-throws');
    sandboxRows = [
      sandbox({ sandboxId: 'sb-bad', sessionId: 'sb-bad', accountId: 'acct-throws' }),
      sandbox({ sandboxId: 'sb-good', sessionId: 'sb-good', accountId: 'acct-ps' }),
    ];

    const result = await reconcileMissingComputeSessions();

    expect(result.checked).toBe(2);
    expect(result.reconciled).toBe(1);
    expect(result.errors).toBe(1);
    expect(openRowFor('sb-good')).not.toBeNull();
    expect(openRowFor('sb-bad')).toBeNull();
  });

  test('is a no-op when internal billing is disabled (self-host)', async () => {
    billingEnabled = false;
    accountsById['acct-ps'] = { billingModel: 'per_seat' };
    sandboxRows = [sandbox({ sandboxId: 'sb-ps', sessionId: 'sb-ps', accountId: 'acct-ps' })];

    const result = await reconcileMissingComputeSessions();

    expect(result).toEqual({ checked: 0, reconciled: 0, errors: 0 });
    expect(computeRows.length).toBe(0);
  });
});

describe('tickRunningComputeCharges', () => {
  test('runs the missing-compute reconciler in the same pass and reports both counts', async () => {
    accountsById['acct-ps'] = { billingModel: 'per_seat' };
    sandboxRows = [sandbox({ sandboxId: 'sb-tick', sessionId: 'sb-tick', accountId: 'acct-ps' })];

    const result = await tickRunningComputeCharges();

    expect(result).toEqual({ settled: 0, reconciled: 1 });
    expect(openRowFor('sb-tick')).not.toBeNull();
  });

  test('is a no-op when internal billing is disabled (self-host)', async () => {
    billingEnabled = false;
    sandboxRows = [sandbox({ sandboxId: 'sb-tick', sessionId: 'sb-tick', accountId: 'acct-ps' })];

    const result = await tickRunningComputeCharges();

    expect(result).toEqual({ settled: 0, reconciled: 0 });
  });
});
