/**
 * The admission/settlement split, pinned.
 *
 * The SQL itself is verified against real Postgres (see the migration
 * 20260901190128060_credit_settlement_overdraft.sql); these tests pin the
 * TypeScript contract that surrounds it — which errors throw, what the caller
 * gets back, and that an overdraft is reported rather than swallowed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: unknown } = { data: null, error: null };

mock.module('../../shared/supabase', () => ({
  getSupabase: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  }),
}));

mock.module('./auto-topup', () => ({
  checkAndTriggerAutoTopup: async () => undefined,
}));

const { settleCredits } = await import('./settle-credits');

beforeEach(() => {
  rpcCalls = [];
  rpcResult = { data: null, error: null };
});

describe('settleCredits — records work already performed', () => {
  test('calls atomic_settle_credits, never atomic_use_credits', async () => {
    // The distinction IS the fix: `atomic_use_credits` refuses below zero, and
    // refusing a settlement deletes the record of spend that already happened.
    rpcResult = {
      data: { success: true, amount_deducted: 2, new_total: 5, overdraft: false, transaction_id: 't' },
      error: null,
    };
    await settleCredits('acct-1', 2, 'LLM · x', 'llm_debit');

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('atomic_settle_credits');
  });

  test('reports an overdraft to the caller instead of failing', async () => {
    rpcResult = {
      data: { success: true, amount_deducted: 5, new_total: -3.01, overdraft: true, transaction_id: 't' },
      error: null,
    };
    const result = await settleCredits('acct-1', 5, 'LLM · x', 'llm_debit');

    expect(result.success).toBe(true);
    expect(result.overdraft).toBe(true);
    expect(result.newBalance).toBe(-3.01);
  });

  test('forwards the idempotency key so a retried settle never double-charges', async () => {
    rpcResult = {
      data: { success: true, amount_deducted: 1, new_total: 0, overdraft: false, transaction_id: 't' },
      error: null,
    };
    await settleCredits('acct-1', 1, 'LLM · x', 'llm_debit', 'llm:evt-9');

    expect(rpcCalls[0].args.p_idempotency_key).toBe('llm:evt-9');
  });

  test('omits the key entirely when none is given — never sends null', async () => {
    rpcResult = {
      data: { success: true, amount_deducted: 1, new_total: 0, overdraft: false, transaction_id: 't' },
      error: null,
    };
    await settleCredits('acct-1', 1, 'LLM · x', 'llm_debit');

    expect('p_idempotency_key' in rpcCalls[0].args).toBe(false);
  });

  test('throws when there is no credit row — a real failure with nothing to record against', async () => {
    rpcResult = { data: { success: false, error: 'No credit account found' }, error: null };

    await expect(settleCredits('acct-missing', 1, 'LLM · x', 'llm_debit')).rejects.toThrow(
      /No credit account found/,
    );
  });

  test('throws on a transport error rather than silently losing the debit', async () => {
    // The failure mode this whole change exists to remove is a lost debit that
    // nobody hears about. A settle that cannot reach the database must be loud.
    rpcResult = { data: null, error: { message: 'connection terminated' } };

    await expect(settleCredits('acct-1', 1, 'LLM · x', 'llm_debit')).rejects.toThrow(
      /connection terminated/,
    );
  });

  test('rejects a ledger type the RPC cannot honestly stamp', async () => {
    // Same guard as deductCredits. The RPC hardcodes `type = 'usage'`, so a
    // granular kind that is NOT a sub-kind of usage ('admin_debit') would
    // manufacture a row claiming to be customer usage in one column and an
    // operator correction in the other — the 2026-07-30 mislabelled-clawback
    // incident, 1,609 rows. Settlement must not become a new way to write one.
    await expect(
      settleCredits('acct-1', 1, 'x', 'admin_debit' as never),
    ).rejects.toThrow();
    expect(rpcCalls).toHaveLength(0);
  });
});
