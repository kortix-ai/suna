/**
 * Characterization suite for `maybeMigrateLegacyAccount` (lazy legacy →
 * per-seat auto-migration), plus the two contracts this file upholds:
 *
 *  1. The account lock is TRANSACTION-scoped with a `lock_timeout` and runs
 *     inside `db.transaction` — never a bare session-level
 *     `pg_advisory_lock`/`pg_advisory_unlock` issued as two independent pooled
 *     statements (KRTX-2089). On the Supabase transaction pooler a session lock
 *     can land on one backend while the rest of the body runs on others, so it
 *     pins nothing — and a swallowed unlock failure wedges that pooled session
 *     forever. `webhook-concurrency.ts` already ships the correct primitive:
 *     `withAccountLock` = `pg_advisory_xact_lock` + `SET LOCAL lock_timeout`
 *     inside a transaction, auto-released at commit/rollback, cross-replica.
 *
 *  2. Every `credit_accounts` write from the migration goes through
 *     `applyStripeSync` (the write-owner chokepoint) so the billing cache is
 *     invalidated and the ownership rules apply (KRTX-2090).
 *
 * The db stub emulates advisory locks with a FIFO mutex: acquiring on
 * `pg_advisory_lock(`, releasing on `pg_advisory_unlock(` (the old shape) and
 * holding a slot for the whole `db.transaction` body (the new shape). That way
 * the "second concurrent sign-in exits as already-per-seat" characterization
 * below holds for BOTH lock mechanisms.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sandboxes } from '@kortix/db';
import type { GrantInput } from '../wallet';
import * as realTiers from './tiers';
import * as realBillingCache from './billing-cache';

// The real tier catalog is real; only the price id is pinned so a catalog
// change cannot flip these tests and the "not configured" refusal is testable.
let perSeatPriceId: string | null = 'price_per_seat_test';
mock.module('./tiers', () => ({
  ...realTiers,
  resolvePerSeatPriceId: () => perSeatPriceId,
}));

const dialect = new PgDialect();
const DAY = 86_400;
const nowSeconds = () => Math.floor(Date.now() / 1000);

type Statement = { sql: string; insideTransaction: boolean };

let account: Record<string, unknown> | null = null;
let sandboxRows: Array<{ sandboxId: string; status: string; metadata: Record<string, unknown>; lastUsedAt: string }> = [];
const statements: Statement[] = [];
const sandboxUpdates: Array<Record<string, unknown>> = [];
const accountWrites: Array<Record<string, unknown>> = [];
const upsertWrites: Array<Record<string, unknown>> = [];
const grants: GrantInput[] = [];
const balanceTxns: Array<Record<string, unknown>> = [];
const createdSubParams: Array<Record<string, any>> = [];
const cancelParams: Array<{ id: string; params: Record<string, any> }> = [];
const stripeCalls: string[] = [];
let customerIds: string[] = [];
let resolvedCustomerId: string | null = null;
let subsByCustomer: Record<string, Array<Record<string, unknown>>> = {};
let activeMembers = 0;
let creditAccountReads = 0;
let createSubError: Error | null = null;
let grantError: Error | null = null;

const invalidateCalls: Array<string | undefined> = [];

// Capture the real invalidator BEFORE mock.module: bun patches the live module
// namespace, so calling `realBillingCache.invalidateAccountBilling` from inside
// the mock would recurse into the mock forever.
const realInvalidateAccountBilling = realBillingCache.invalidateAccountBilling;

// FIFO mutex standing in for the advisory-lock slot. Exactly one holder; the
// release function is returned so the stub can hand it to the unlock path.
function makeMutex() {
  let held = false;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<() => void> {
      if (held) await new Promise<void>((resolve) => waiters.push(resolve));
      held = true;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const next = waiters.shift();
        if (next) next();
        else held = false;
      };
    },
  };
}
const mutex = makeMutex();
let heldRelease: (() => void) | null = null;

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => {
    creditAccountReads += 1;
    return account;
  },
  updateCreditAccount: async (_id: string, data: Record<string, unknown>) => {
    accountWrites.push({ ...data });
    account = { ...(account ?? {}), ...data };
  },
  upsertCreditAccount: async (_id: string, data: Record<string, unknown>) => {
    upsertWrites.push({ ...data });
    account = { ...(account ?? {}), ...data };
  },
}));

mock.module('../repositories/customers', () => ({
  listAccountStripeCustomerIds: async () => customerIds,
}));

mock.module('./subscriptions', () => ({
  resolveLiveStripeCustomerId: async () => resolvedCustomerId,
}));

mock.module('./seat-management', () => ({
  countActiveMembers: async () => activeMembers,
}));

mock.module('../wallet', () => ({
  wallet: {
    grant: async (input: GrantInput) => {
      if (grantError) throw grantError;
      grants.push(input);
      return { replayed: false, ledgerId: null };
    },
  },
}));

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    subscriptions: {
      list: async (query: { customer: string }) => {
        stripeCalls.push(`list:${query.customer}`);
        return { data: subsByCustomer[query.customer] ?? [] };
      },
      create: async (params: Record<string, any>) => {
        stripeCalls.push('create');
        createdSubParams.push(params);
        if (createSubError) throw createSubError;
        return { id: 'sub_seat_1', status: 'active', items: { data: [{ id: 'si_seat_1' }] } };
      },
      cancel: async (id: string, params: Record<string, any>) => {
        stripeCalls.push(`cancel:${id}`);
        cancelParams.push({ id, params });
        return { id };
      },
    },
    customers: {
      createBalanceTransaction: async (_customerId: string, params: Record<string, unknown>) => {
        stripeCalls.push('balance');
        balanceTxns.push(params);
        return { id: 'cbtxn_1' };
      },
    },
  }),
}));

mock.module('./billing-cache', () => ({
  ...realBillingCache,
  invalidateAccountBilling: (accountId?: string) => {
    invalidateCalls.push(accountId);
    realInvalidateAccountBilling(accountId);
  },
}));

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => {
        const chain = {
          where: () => chain,
          limit: () => chain,
          orderBy: () => chain,
          then: (resolve: (rows: typeof sandboxRows) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(sandboxRows).then(resolve, reject),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          sandboxUpdates.push({ ...data });
          return [];
        },
      }),
    }),
    execute: async (query: unknown) => {
      const sqlText = dialect.sqlToQuery(query as any).sql;
      statements.push({ sql: sqlText, insideTransaction: false });
      if (sqlText.includes('pg_advisory_lock(')) heldRelease = await mutex.acquire();
      if (sqlText.includes('pg_advisory_unlock(')) {
        heldRelease?.();
        heldRelease = null;
      }
      return [];
    },
    transaction: async <T>(
      fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<T>,
    ): Promise<T> => {
      const release = await mutex.acquire();
      const tx = {
        execute: async (q: unknown) => {
          statements.push({ sql: dialect.sqlToQuery(q as any).sql, insideTransaction: true });
          return [];
        },
      };
      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  },
}));

const { maybeMigrateLegacyAccount } = await import('./legacy-account-migration');
const { resolveAccountBilling } = await import('./billing-cache');

function legacySub(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    id,
    status: 'active',
    customer: 'cus_legacy',
    current_period_start: now - 10 * DAY,
    current_period_end: now + 10 * DAY,
    metadata: {},
    items: { data: [{ price: { unit_amount: 4000 }, quantity: 10 }] },
    ...overrides,
  };
}

/**
 * Two legacy machine subs at $40/unit × quantity 10, each exactly half-way
 * through its period → $200 prorated each, $400 total. 3 seats cost $120, so
 * the first seat period is fully covered and $280 is granted as wallet credit.
 * A ±1 s wall-clock drift moves the proration by ~$0.0002, far from the
 * round2 boundary, so the assertions stay deterministic.
 */
function happyPathSetup(overrides: {
  customerIds?: string[];
  resolvedCustomerId?: string | null;
} = {}): void {
  customerIds = overrides.customerIds ?? ['cus_legacy'];
  // Explicit null must stay null (the "no canonical customer" case), so no ?? here.
  resolvedCustomerId = 'resolvedCustomerId' in overrides ? overrides.resolvedCustomerId! : 'cus_canonical';
  subsByCustomer = {
    cus_legacy: [legacySub('sub_m1')],
    cus_canonical: [legacySub('sub_m2')],
  };
  activeMembers = 3;
}

beforeEach(() => {
  account = {
    accountId: 'acct-1',
    tier: 'free',
    billingModel: 'legacy',
    commitmentType: null,
    commitmentEndDate: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    seatCount: null,
    seatSubscriptionItemId: null,
    autoTopupCustomized: false,
    autoTopupThreshold: null,
    autoTopupAmount: null,
  };
  sandboxRows = [1, 2, 3, 4].map((n) => ({
    sandboxId: `sb-${n}`,
    status: 'active',
    metadata: {},
    // Descending, exactly as the DB would return with ORDER BY last_used_at DESC.
    lastUsedAt: new Date(Date.now() + (100 - n) * 1_000).toISOString(),
  }));
  statements.length = 0;
  sandboxUpdates.length = 0;
  accountWrites.length = 0;
  upsertWrites.length = 0;
  grants.length = 0;
  balanceTxns.length = 0;
  createdSubParams.length = 0;
  cancelParams.length = 0;
  stripeCalls.length = 0;
  invalidateCalls.length = 0;
  customerIds = [];
  resolvedCustomerId = null;
  subsByCustomer = {};
  activeMembers = 0;
  creditAccountReads = 0;
  createSubError = null;
  grantError = null;
  perSeatPriceId = 'price_per_seat_test';
  realInvalidateAccountBilling();
  heldRelease = null;
});

describe('maybeMigrateLegacyAccount — refusal conditions', () => {
  test('no credit account → skipped:no_subs', async () => {
    account = null;
    const result = await maybeMigrateLegacyAccount('acct-1');
    expect(result.status).toBe('skipped:no_subs');
    expect(result.reason).toBe('No credit account');
    expect(stripeCalls).toEqual([]);
  });

  test('already per_seat → skipped:already_per_seat, no Stripe work', async () => {
    account = { ...account, billingModel: 'per_seat' };
    const result = await maybeMigrateLegacyAccount('acct-1');
    expect(result.status).toBe('skipped:already_per_seat');
    expect(stripeCalls).toEqual([]);
    expect(accountWrites).toEqual([]);
  });

  test('active yearly commitment → skipped:yearly_commitment', async () => {
    account = {
      ...account,
      commitmentType: 'yearly_commitment',
      commitmentEndDate: new Date(Date.now() + 30 * DAY * 1_000).toISOString(),
    };
    const result = await maybeMigrateLegacyAccount('acct-1');
    expect(result.status).toBe('skipped:yearly_commitment');
    expect(result.reason).toContain('Commitment active until');
    expect(stripeCalls).toEqual([]);
  });

  test('expired commitment does not refuse (proceeds to the machine check)', async () => {
    account = {
      ...account,
      commitmentType: 'yearly_commitment',
      commitmentEndDate: new Date(Date.now() - DAY * 1_000).toISOString(),
    };
    sandboxRows = [];
    const result = await maybeMigrateLegacyAccount('acct-1');
    expect(result.status).toBe('skipped:no_legacy_machine');
  });

  test('no legacy machine (no sandboxes) → skipped:no_legacy_machine, no Stripe work', async () => {
    sandboxRows = [];
    const result = await maybeMigrateLegacyAccount('acct-1');
    expect(result.status).toBe('skipped:no_legacy_machine');
    expect(stripeCalls).toEqual([]);
    expect(accountWrites).toEqual([]);
  });
});

describe('maybeMigrateLegacyAccount — happy path', () => {
  test('prorates the legacy subs, pre-pays the first seat period, grants the leftover', async () => {
    happyPathSetup();

    const result = await maybeMigrateLegacyAccount('acct-1');

    expect(result.status).toBe('migrated');
    expect(result.proratedCreditUsd).toBe(280);
    expect(result.firstSeatCoveredUsd).toBe(120);
    expect(result.cancelledSubIds).toEqual(['sub_m1', 'sub_m2']);
    expect(result.newSubscriptionId).toBe('sub_seat_1');
    expect(result.stoppedSandboxIds).toEqual(['sb-4']);

    // First-seat offset: a NEGATIVE customer-balance transaction (a credit),
    // applied before the seat sub is created.
    expect(balanceTxns).toEqual([
      {
        amount: -12_000,
        currency: 'usd',
        description: 'Legacy machine credit applied to first seat period',
      },
    ]);

    // The seat sub: member count, charge-automatically, provenance metadata.
    expect(createdSubParams).toEqual([
      {
        customer: 'cus_canonical',
        items: [{ price: 'price_per_seat_test', quantity: 3 }],
        collection_method: 'charge_automatically',
        metadata: {
          account_id: 'acct-1',
          billing_model: 'per_seat',
          initial_seat_count: '3',
          source: 'lazy_migration',
        },
      },
    ]);

    // Legacy subs are cancelled only AFTER the replacement exists.
    expect(stripeCalls.indexOf('create')).toBeLessThan(stripeCalls.indexOf('cancel:sub_m1'));
    expect(cancelParams).toEqual([
      { id: 'sub_m1', params: { prorate: false } },
      { id: 'sub_m2', params: { prorate: false } },
    ]);

    // Leftover → non-expiring wallet credit of kind legacy_migration.
    expect(grants).toEqual([
      {
        accountId: 'acct-1',
        amount: 280,
        kind: 'legacy_migration',
        description: expect.stringContaining('cancelled 2 subscriptions'),
        expiring: false,
        key: null,
      },
    ]);

    // billing_model flipped through the write owner with the seat sub recorded.
    expect(upsertWrites).toEqual([]);
    expect(accountWrites).toEqual([
      {
        billingModel: 'per_seat',
        seatCount: 3,
        seatSubscriptionItemId: 'si_seat_1',
        stripeSubscriptionId: 'sub_seat_1',
        stripeSubscriptionStatus: 'active',
        autoTopupEnabled: true,
        autoTopupThreshold: String(realTiers.defaultAutoTopupForSeats(3).threshold),
        autoTopupAmount: String(realTiers.defaultAutoTopupForSeats(3).amount),
      },
    ]);

    // Sandbox surplus: the seat count is 3, the 4th (least recently used) stops.
    expect(sandboxUpdates).toHaveLength(1);
    expect(sandboxUpdates[0].status).toBe('stopped');
    const metadataQuery = dialect.sqlToQuery(sandboxUpdates[0].metadata as any);
    expect(metadataQuery.sql).toContain('COALESCE');
    expect(String(metadataQuery.params[0])).toContain('legacy_migration');
  });

  test('a per_seat sub in the inventory is never cancelled', async () => {
    happyPathSetup();
    subsByCustomer.cus_canonical = [
      legacySub('sub_m2'),
      legacySub('sub_seat_0', { metadata: { billing_model: 'per_seat' } }),
    ];

    const result = await maybeMigrateLegacyAccount('acct-1');

    expect(result.status).toBe('migrated');
    expect(result.cancelledSubIds).toEqual(['sub_m1', 'sub_m2']);
    expect(stripeCalls).not.toContain('cancel:sub_seat_0');
  });

  test('a stale customer id that errors on list is skipped, the rest still migrate', async () => {
    happyPathSetup();
    subsByCustomer = { cus_canonical: [legacySub('sub_m2')] };
    const realList = subsByCustomer;
    subsByCustomer = new Proxy(realList, {
      get(target, key: string) {
        if (key === 'cus_legacy') throw new Error('No such customer: cus_legacy');
        return target[key];
      },
    });

    const result = await maybeMigrateLegacyAccount('acct-1');

    expect(result.status).toBe('migrated');
    expect(result.cancelledSubIds).toEqual(['sub_m2']);
    expect(result.proratedCreditUsd).toBe(80);
  });

  test('no active subs → flips billing_model only, no Stripe writes', async () => {
    happyPathSetup();
    subsByCustomer = { cus_legacy: [], cus_canonical: [] };

    const result = await maybeMigrateLegacyAccount('acct-1');

    expect(result.status).toBe('skipped:no_subs');
    expect(accountWrites).toEqual([{ billingModel: 'per_seat' }]);
    expect(upsertWrites).toEqual([]);
    expect(cancelParams).toEqual([]);
    expect(createdSubParams).toEqual([]);
  });
});

describe('maybeMigrateLegacyAccount — failure paths leave the account intact', () => {
  test('seat sub creation fails → failed, legacy subs untouched, no account write', async () => {
    happyPathSetup();
    createSubError = new Error('card_declined');

    const result = await maybeMigrateLegacyAccount('acct-1');

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('create per-seat sub: card_declined');
    expect(cancelParams).toEqual([]);
    expect(grants).toEqual([]);
    expect(accountWrites).toEqual([]);
    expect(upsertWrites).toEqual([]);
    expect(account?.billingModel).toBe('legacy');
  });

  test('per-seat price not configured → failed before any Stripe write', async () => {
    happyPathSetup();
    perSeatPriceId = null;

    const result = await maybeMigrateLegacyAccount('acct-1');

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('per-seat price not configured');
    expect(cancelParams).toEqual([]);
    expect(createdSubParams).toEqual([]);
    expect(accountWrites).toEqual([]);
  });

  test('active subs but no canonical Stripe customer → failed, subs left for cleanup', async () => {
    happyPathSetup({ customerIds: ['cus_old'], resolvedCustomerId: null });
    subsByCustomer = { cus_old: [legacySub('sub_m1')] };

    const result = await maybeMigrateLegacyAccount('acct-1');

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('no Stripe customer for account with active subs');
    expect(cancelParams).toEqual([]);
    expect(accountWrites).toEqual([]);
  });

  test('wallet grant fails → failed, billing_model NOT flipped', async () => {
    happyPathSetup();
    grantError = new Error('wallet down');

    const result = await maybeMigrateLegacyAccount('acct-1');

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('credit grant: wallet down');
    expect(result.cancelledSubIds).toEqual([]);
    expect(accountWrites).toEqual([]);
    expect(account?.billingModel).toBe('legacy');
  });
});

describe('maybeMigrateLegacyAccount — concurrency', () => {
  test('two concurrent sign-ins serialize through the account lock; one migrates, one skips', async () => {
    happyPathSetup();

    const [a, b] = await Promise.all([
      maybeMigrateLegacyAccount('acct-1'),
      maybeMigrateLegacyAccount('acct-1'),
    ]);

    // Exactly one call holds the lock and migrates; the other re-reads the row
    // inside the lock, sees per_seat, and exits. Which call wins the race is
    // not observable; the outcome set is.
    expect([a.status, b.status].sort()).toEqual(['migrated', 'skipped:already_per_seat']);
    expect(createdSubParams).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(accountWrites).toHaveLength(1);
  });
});

describe('the migration lock is transaction-scoped (KRTX-2089)', () => {
  test('the locked body runs inside db.transaction with pg_advisory_xact_lock + lock_timeout — never a bare session lock on the pool', async () => {
    happyPathSetup();
    subsByCustomer = { cus_legacy: [], cus_canonical: [] }; // cheapest path into the lock

    const result = await maybeMigrateLegacyAccount('acct-1');
    expect(result.status).toBe('skipped:no_subs');

    const lockStatements = statements.filter((s) =>
      /pg_advisory_(xact_)?lock|pg_advisory_unlock/.test(s.sql),
    );
    // Exactly ONE lock statement: the transaction-scoped xact lock. No bare
    // session lock, and no manual unlock (the transaction ends the lock by
    // itself at commit/rollback).
    expect(lockStatements).toHaveLength(1);
    expect(lockStatements[0].sql).toContain('pg_advisory_xact_lock');
    expect(lockStatements[0].insideTransaction).toBe(true);
    // The transaction bounds the wait with lock_timeout before acquiring…
    expect(statements.some((s) => s.insideTransaction && /set local lock_timeout/i.test(s.sql))).toBe(true);
    // …and nothing lock-related is ever issued directly on the pooled
    // connection, outside the transaction.
    expect(statements.some((s) => !s.insideTransaction && /pg_advisory/.test(s.sql))).toBe(false);
  });
});

describe('account writes go through the write-owner chokepoint (KRTX-2090)', () => {
  test('the migration invalidates the billing cache: a read within the TTL sees per_seat', async () => {
    happyPathSetup();

    const before = await resolveAccountBilling('acct-1', { now: 1_000_000 });
    expect(before.plan.key).toBe('free');

    const result = await maybeMigrateLegacyAccount('acct-1');
    expect(result.status).toBe('migrated');

    expect(invalidateCalls).toContain('acct-1');
    const readsAfterWrite = creditAccountReads;

    const after = await resolveAccountBilling('acct-1', { now: 1_000_001 });
    expect(after.plan.key).toBe('per_seat');
    expect(creditAccountReads).toBeGreaterThan(readsAfterWrite); // cache actually re-read
  });

  test('the no-subs flip invalidates the billing cache too', async () => {
    happyPathSetup();
    subsByCustomer = { cus_legacy: [], cus_canonical: [] };

    const before = await resolveAccountBilling('acct-1', { now: 2_000_000 });
    expect(before.plan.key).toBe('free');
    const readsAfterWarm = creditAccountReads;

    const result = await maybeMigrateLegacyAccount('acct-1');
    expect(result.status).toBe('skipped:no_subs');

    expect(invalidateCalls).toContain('acct-1');
    await resolveAccountBilling('acct-1', { now: 2_000_001 });
    expect(creditAccountReads).toBeGreaterThan(readsAfterWarm);
  });
});
