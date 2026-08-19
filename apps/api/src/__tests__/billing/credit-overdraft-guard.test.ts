// Service-layer half of the overdraft-guard regression lock.
//
// The guard itself lives in SQL (atomic_use_credits) and is exercised against a
// real PostgreSQL in
// packages/db/scripts/atomic-use-credits-balance-guard.integration.test.ts.
// This unit suite is hermetic — scripts/test.env points DATABASE_URL at a dead
// port on purpose — so what is asserted HERE is the other half: that
// billing/services/credits.ts propagates the guard's refusal instead of
// swallowing it, and that a caller cannot walk a wallet negative by looping.
//
// The fake RPC below is a stateful wallet that reproduces the shipped function's
// decision rule (compare p_amount against the SUM of all three buckets under a
// lock, refuse before moving anything). It is not a re-implementation used to
// prove the SQL correct — the container test does that — it is the fixture that
// lets the service path be driven through the refusal.
import { beforeEach, describe, expect, test } from 'bun:test';
import { mockRegistry, registerGlobalMocks, resetMockRegistry } from './mocks';

registerGlobalMocks();

interface Wallet {
  daily: number;
  expiring: number;
  nonExpiring: number;
}

let wallet: Wallet;
let ledgerRows: { amount: number; ledgerType: string; description: string }[] = [];

function total(): number {
  return wallet.daily + wallet.expiring + wallet.nonExpiring;
}

function atomicUseCredits(params: Record<string, unknown>) {
  const amount = Number(params.p_amount);
  const ledgerType = String(params.p_ledger_type ?? 'usage');
  const description = String(params.p_description ?? 'Credit usage');

  if (amount <= 0) {
    return { data: { success: false, error: 'Amount must be positive' }, error: null };
  }
  if (total() < amount) {
    return {
      data: { success: false, error: 'Insufficient credits', required: amount, available: total() },
      error: null,
    };
  }

  let remaining = amount;
  for (const bucket of ['daily', 'expiring', 'nonExpiring'] as const) {
    const take = Math.min(wallet[bucket], remaining);
    wallet[bucket] -= take;
    remaining -= take;
  }
  ledgerRows.push({ amount: -amount, ledgerType, description });

  return {
    data: {
      success: true,
      amount_deducted: amount,
      new_total: total(),
      transaction_id: `tx_${ledgerRows.length}`,
    },
    error: null,
  };
}

beforeEach(() => {
  resetMockRegistry();
  wallet = { daily: 0, expiring: 10, nonExpiring: 0 };
  ledgerRows = [];

  mockRegistry.supabaseRpc = {
    rpc: (name: string, params?: Record<string, unknown>) =>
      Promise.resolve(
        name === 'atomic_use_credits'
          ? atomicUseCredits(params ?? {})
          : { data: null, error: null },
      ),
  } as never;

  mockRegistry.getCreditAccount = async () =>
    ({
      accountId: 'acc_test_123',
      balance: String(total()),
      expiringCredits: String(wallet.expiring),
      nonExpiringCredits: String(wallet.nonExpiring),
      dailyCreditsBalance: String(wallet.daily),
    }) as never;
});

const { deductCredits } = await import('../../billing/services/credits');
const { LedgerTypeMismatchError } = await import('../../billing/ledger-type-honesty');

describe('overdraft guard — service layer (regression: 20260712160001000)', () => {
  test('a debit larger than the balance throws InsufficientCreditsError', async () => {
    await expect(deductCredits('acc_test_123', 25, 'Overdraft attempt', 'llm_debit')).rejects.toThrow(
      /Insufficient credits/,
    );
  });

  test('the thrown error reports the real balance and the amount required', async () => {
    try {
      await deductCredits('acc_test_123', 25, 'Overdraft attempt', 'llm_debit');
      throw new Error('unreachable');
    } catch (err) {
      const insufficient = err as { name: string; balance: number; required: number };
      expect(insufficient.name).toBe('InsufficientCreditsError');
      expect(insufficient.balance).toBe(10);
      expect(insufficient.required).toBe(25);
    }
  });

  test('a refused debit moves no money and writes no ledger row', async () => {
    await deductCredits('acc_test_123', 25, 'Overdraft attempt', 'llm_debit').catch(
      () => undefined,
    );

    expect(total()).toBe(10);
    expect(ledgerRows).toEqual([]);
  });

  test('a debit for exactly the balance succeeds and drains to zero', async () => {
    const result = await deductCredits('acc_test_123', 10, 'Exact drain', 'compute_debit');

    expect(result.success).toBe(true);
    expect(result.newBalance).toBe(0);
    expect(total()).toBe(0);
  });

  test('repeated metering ticks cannot walk the balance negative', async () => {
    let refusals = 0;
    for (let tick = 0; tick < 6; tick += 1) {
      await deductCredits('acc_test_123', 3, `Tick ${tick}`, 'compute_debit').catch(() => {
        refusals += 1;
      });
    }

    expect(total()).toBe(1);
    expect(ledgerRows.length).toBe(3);
    expect(refusals).toBe(3);
  });

  test('the guard sums all three buckets rather than any single one', async () => {
    wallet = { daily: 1, expiring: 2, nonExpiring: 3 };
    const result = await deductCredits('acc_test_123', 6, 'Spans all buckets', 'compute_debit');

    expect(result.success).toBe(true);
    expect(total()).toBe(0);
  });
});

describe('ledger-type honesty at the RPC boundary', () => {
  test('a non-usage ledgerType is refused before the RPC is reached', async () => {
    await expect(
      deductCredits('acc_test_123', 1, 'Entitlement clawback', 'admin_debit' as never),
    ).rejects.toThrow(LedgerTypeMismatchError);
    expect(ledgerRows).toEqual([]);
    expect(total()).toBe(10);
  });

  test.each([['usage'], ['llm_debit'], ['compute_debit'], ['token_deduction'], ['token_overage']])(
    'the usage-family kind %s still reaches the RPC',
    async (kind) => {
      await deductCredits('acc_test_123', 1, 'Billed work', kind as never);
      expect(ledgerRows[0]!.ledgerType).toBe(kind);
    },
  );
});
