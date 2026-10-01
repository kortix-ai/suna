import { beforeEach, expect, mock, test } from 'bun:test';

const calls: string[] = [];
let fail = false;
let replayed = true;
let releaseWallet: (() => void) | undefined;
const walletResult = async (name: string) => {
  calls.push(name);
  if (fail) throw new Error('refused');
  if (releaseWallet) await new Promise<void>((resolve) => { releaseWallet = resolve; });
  return { replayed };
};
mock.module('../wallet', () => ({ wallet: {
  debit: () => walletResult('debit'),
  settle: () => walletResult('settle'),
} }));
mock.module('./auto-topup', () => ({ checkAndTriggerAutoTopup: () => { calls.push('topup'); } }));
const { debitAndCheckAutoTopup, settleAndCheckAutoTopup } = await import('./wallet-debits');
const input = { accountId: 'acct', amount: 1, description: 'usage', kind: 'usage' as const, key: null };
beforeEach(() => { calls.length = 0; fail = false; replayed = true; releaseWallet = undefined; });
for (const [name, operation] of [['debit', debitAndCheckAutoTopup], ['settle', settleAndCheckAutoTopup]] as const) {
  test(`${name} triggers after successful replay`, async () => {
    expect((await operation(input)).replayed).toBe(true);
    expect(calls).toEqual([name, 'topup']);
  });
  test(`${name} triggers only after a successful first wallet result`, async () => {
    replayed = false;
    releaseWallet = () => {};
    const pending = operation(input);
    expect(calls).toEqual([name]);
    releaseWallet();
    expect((await pending).replayed).toBe(false);
    expect(calls).toEqual([name, 'topup']);
  });
  test(`${name} does not trigger after failure`, async () => {
    fail = true;
    await expect(operation(input)).rejects.toThrow('refused');
    expect(calls).toEqual([name]);
  });
}
