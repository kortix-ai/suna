// The wallet's failure branches, which a healthy database never takes. The
// ledger rows each operation writes are pinned against real PostgreSQL in
// tests/migration/wallet-ledger.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let executeError: unknown = null;
let rpcResult: Record<string, unknown> = { success: true };

mock.module('../../shared/db', () => ({
  db: {
    execute: async () => {
      if (executeError) throw executeError;
      return [{ result: rpcResult }];
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));

mock.module('../services/auto-topup', () => ({
  checkAndTriggerAutoTopup: async () => undefined,
}));

const { wallet } = await import('./index');
const { InsufficientCreditsError } = await import('../errors');

/** A Drizzle failure: the pg detail hangs off `cause`, not `message`. */
function queryError(cause: Record<string, unknown>) {
  return Object.assign(new Error('Failed query: select kortix_wallet.grant_credits(...)'), { cause });
}

const duplicate = queryError({
  code: '23505',
  message: 'duplicate key value violates unique constraint "kortix_unique_stripe_event"',
  constraint_name: 'kortix_unique_stripe_event',
});
const lostConnection = queryError({ message: 'connection terminated' });

beforeEach(() => {
  executeError = null;
  rpcResult = { success: true };
});

describe('wallet failure branches', () => {
  test('a debit that cannot reach the database is refused as a deduction error', async () => {
    executeError = lostConnection;
    const error = await wallet
      .debit({ accountId: 'acct', amount: 1, description: 'x', kind: 'usage', key: null })
      .catch((err) => err);
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(error.reason).toBe('Deduction error');
    expect(error.statusCode).toBe(402);
  });

  test('a settlement that cannot reach the database fails loudly', async () => {
    executeError = lostConnection;
    await expect(
      wallet.settle({ accountId: 'acct', amount: 1, description: 'x', kind: 'llm_debit', key: null }),
    ).rejects.toThrow('Credit settlement failed for acct: Failed query');
  });

  test('a grant that loses a same-key race reports a replay', async () => {
    executeError = duplicate;
    expect(
      await wallet.grant({
        accountId: 'acct',
        amount: 1,
        kind: 'purchase',
        description: 'x',
        expiring: false,
        key: { event: 'pi_1' },
      }),
    ).toEqual({ replayed: true, ledgerId: null });
  });

  test('any other grant failure propagates', async () => {
    executeError = lostConnection;
    await expect(
      wallet.grant({ accountId: 'acct', amount: 1, kind: 'purchase', description: 'x', expiring: false, key: null }),
    ).rejects.toThrow('Failed query');
  });

  // The duplicate half (a replayed reset is a no-op) is proven on PostgreSQL by
  // tests/migration/wallet-ledger.test.ts "a replayed reset key is a silent no-op".
  test('a reset failure other than a duplicate propagates', async () => {
    const renewal = { accountId: 'acct', amount: 5, description: 'x', key: { event: 'in_1' } };
    executeError = lostConnection;
    await expect(wallet.reset(renewal)).rejects.toThrow('Failed query');
  });
});

describe('settlement overdraft logging', () => {
  /** Capture the warn lines while one settlement runs, restored in `finally`. */
  async function settleWithWarnCapture(
    input: Parameters<typeof wallet.settle>[0],
  ): Promise<string[]> {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => warns.push(parts.map(String).join(' '));
    try {
      await wallet.settle(input);
    } finally {
      console.warn = originalWarn;
    }
    return warns;
  }

  const settleInput = {
    accountId: 'acct',
    amount: 0.6,
    description: 'x',
    kind: 'compute_debit' as const,
    key: null,
  };

  // Characterization for the 2026-09-26 warn spike: a box that keeps running on
  // a drained wallet settles every few minutes. Only the settlement that FIRST
  // takes the balance below zero may warn; the repeats are the same state.
  test('warns on the settlement that first drains the wallet, not on the repeats', async () => {
    rpcResult = { success: true, amount_deducted: 0.6, new_total: -0.6, overdraft: true, transaction_id: 't1' };
    const first = await settleWithWarnCapture(settleInput); // balance 0.00 -> -0.60: the transition
    expect(first.filter((line) => line.includes('settlement overdraft'))).toHaveLength(1);

    rpcResult = { success: true, amount_deducted: 0.6, new_total: -1.2, overdraft: true, transaction_id: 't2' };
    const repeat = await settleWithWarnCapture(settleInput); // -0.60 -> -1.20: same state
    expect(repeat.filter((line) => line.includes('settlement overdraft'))).toHaveLength(0);
  });

  test('warns again when the account drains a second time after a top-up', async () => {
    rpcResult = { success: true, amount_deducted: 0.6, new_total: 0.4, overdraft: false, transaction_id: 't2' };
    await settleWithWarnCapture(settleInput); // a top-up lands the drained wallet at 1.00 -> 0.40

    rpcResult = { success: true, amount_deducted: 0.6, new_total: -0.2, overdraft: true, transaction_id: 't3' };
    const drainedAgain = await settleWithWarnCapture(settleInput); // 0.40 -> -0.20: a new episode
    expect(drainedAgain.filter((line) => line.includes('settlement overdraft'))).toHaveLength(1);
  });
});
