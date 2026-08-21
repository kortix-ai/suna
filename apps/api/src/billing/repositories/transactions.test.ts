import { beforeEach, describe, expect, mock, test } from 'bun:test';

let inserted: Record<string, unknown>[] = [];

mock.module('../../shared/db', () => ({
  db: {
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(data);
          return [{ id: 'ledger_row_1', ...data }];
        },
      }),
    }),
  }, auditDb: {
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(data);
          return [{ id: 'ledger_row_1', ...data }];
        },
      }),
    }),
  },
  hasDatabase: false,
}));

const { insertLedgerEntry } = await import('./transactions');
const { LedgerTypeMismatchError } = await import('../ledger-type-honesty');

beforeEach(() => {
  inserted = [];
});

describe('insertLedgerEntry honesty guard', () => {
  test('writes a row whose type nothing contradicts', async () => {
    const row = await insertLedgerEntry({
      accountId: 'acc_1',
      amount: '50',
      balanceAfter: '150',
      type: 'tier_grant',
      description: 'Monthly grant',
      isExpiring: true,
    } as never);

    expect(inserted.length).toBe(1);
    expect((row as { type: string }).type).toBe('tier_grant');
  });

  test('writes the forfeiture row account deletion depends on', async () => {
    await insertLedgerEntry({
      accountId: 'acc_1',
      amount: '-12',
      balanceAfter: '0',
      type: 'forfeiture',
      description: 'Account deletion: credit balance forfeited',
      isExpiring: false,
    } as never);

    expect(inserted.length).toBe(1);
  });

  test('refuses the 2026-07-30 mislabelled-clawback shape', async () => {
    await expect(
      insertLedgerEntry({
        accountId: 'acc_1',
        amount: '-5239.44',
        balanceAfter: '0',
        type: 'usage',
        description: 'Entitlement clawback',
        metadata: { ledger_type: 'admin_debit' },
      } as never),
    ).rejects.toThrow(LedgerTypeMismatchError);
  });

  test('a refused row never reaches the database', async () => {
    await insertLedgerEntry({
      accountId: 'acc_1',
      amount: '-5239.44',
      balanceAfter: '0',
      type: 'usage',
      description: 'Entitlement clawback',
      metadata: { ledger_type: 'admin_debit' },
    } as never).catch(() => undefined);

    expect(inserted).toEqual([]);
  });

  test('refuses a usage-typed row whose description reads as a reconciliation', async () => {
    await expect(
      insertLedgerEntry({
        accountId: 'acc_1',
        amount: '-5239.44',
        balanceAfter: '0',
        type: 'usage',
        description: 'Entitlement reconciliation clawback 2026-07',
      } as never),
    ).rejects.toThrow(LedgerTypeMismatchError);
    expect(inserted).toEqual([]);
  });

  test('accepts the same correction once it is typed honestly', async () => {
    await insertLedgerEntry({
      accountId: 'acc_1',
      amount: '-5239.44',
      balanceAfter: '0',
      type: 'admin_debit',
      description: 'Entitlement reconciliation clawback 2026-07',
      metadata: { ledger_type: 'admin_debit' },
    } as never);

    expect(inserted.length).toBe(1);
    expect(inserted[0]!.type).toBe('admin_debit');
  });

  test('still accepts the RPC-shaped usage row with a granular sub-kind', async () => {
    await insertLedgerEntry({
      accountId: 'acc_1',
      amount: '-0.42',
      balanceAfter: '99.58',
      type: 'usage',
      description: 'LLM · anthropic/claude-sonnet-4.6',
      metadata: { from_daily: 0, from_monthly: 0.42, from_extra: 0, ledger_type: 'llm_debit' },
    } as never);

    expect(inserted.length).toBe(1);
  });
});
