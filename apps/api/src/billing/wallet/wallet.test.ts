// The wallet's failure branches, which a healthy database never takes. The
// ledger rows each operation writes are pinned against real PostgreSQL in
// tests/migration/wallet-ledger.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let executeError: unknown = null;

mock.module('../../shared/db', () => ({
  db: {
    execute: async () => {
      if (executeError) throw executeError;
      return [{ result: { success: true } }];
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));

mock.module('../services/auto-topup', () => ({
  checkAndTriggerAutoTopup: async () => undefined,
}));

const { wallet } = await import('./index');
const { InsufficientCreditsError } = await import('../../errors');

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

  test('a reset refused as a duplicate is a no-op, and any other failure propagates', async () => {
    const renewal = { accountId: 'acct', amount: 5, description: 'x', key: { event: 'in_1' } };
    executeError = duplicate;
    await expect(wallet.reset(renewal)).resolves.toBeUndefined();
    executeError = lostConnection;
    await expect(wallet.reset(renewal)).rejects.toThrow('Failed query');
  });
});
