import { beforeEach, expect, mock, test } from 'bun:test';

const calls: string[] = [];
let fail = false;
mock.module('../wallet', () => ({ wallet: {
  debit: async () => { calls.push('debit'); if (fail) throw new Error('refused'); return { replayed: true }; },
  settle: async () => { calls.push('settle'); if (fail) throw new Error('refused'); return { replayed: true }; },
} }));
mock.module('./auto-topup', () => ({ checkAndTriggerAutoTopup: () => { calls.push('topup'); } }));
const { debitAndCheckAutoTopup, settleAndCheckAutoTopup } = await import('./wallet-debits');
const input = { accountId: 'acct', amount: 1, description: 'usage', kind: 'usage' as const, key: null };
beforeEach(() => { calls.length = 0; fail = false; });
for (const [name, operation] of [['debit', debitAndCheckAutoTopup], ['settle', settleAndCheckAutoTopup]] as const) {
  test(`${name} triggers after successful replay`, async () => {
    expect((await operation(input)).replayed).toBe(true);
    expect(calls).toEqual([name, 'topup']);
  });
  test(`${name} does not trigger after failure`, async () => {
    fail = true;
    await expect(operation(input)).rejects.toThrow('refused');
    expect(calls).toEqual([name]);
  });
}
