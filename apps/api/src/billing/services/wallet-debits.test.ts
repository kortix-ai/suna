import { beforeEach, expect, mock, test } from 'bun:test';

const calls: string[] = [];
let fail = false;
let replayed = true;
let balance: number | undefined;
let releaseWallet: (() => void) | undefined;
const walletResult = async (name: string) => {
  calls.push(name);
  if (fail) throw new Error('refused');
  if (releaseWallet) await new Promise<void>((resolve) => { releaseWallet = resolve; });
  return { replayed, balance };
};
const zeroAlerts: Array<{ accountId: string; balance: number }> = [];
mock.module('../wallet', () => ({ wallet: {
  debit: () => walletResult('debit'),
  settle: () => walletResult('settle'),
} }));
mock.module('./auto-topup', () => ({ checkAndTriggerAutoTopup: () => { calls.push('topup'); } }));
mock.module('./wallet-zero-alert', () => ({
  alertWalletAtZero: async (accountId: string, at: number) => { zeroAlerts.push({ accountId, balance: at }); return 1; },
}));
const { debitAndCheckAutoTopup, settleAndCheckAutoTopup } = await import('./wallet-debits');
const input = { accountId: 'acct', amount: 1, description: 'usage', kind: 'usage' as const, key: null };
beforeEach(() => { calls.length = 0; fail = false; replayed = true; balance = undefined; releaseWallet = undefined; zeroAlerts.length = 0; });
/** The alert is fire-and-forget behind a lazy import: let it land. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
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

// KRTX-1718: a debit that leaves the wallet at $0 or below tells the owners.
for (const [name, operation] of [['debit', debitAndCheckAutoTopup], ['settle', settleAndCheckAutoTopup]] as const) {
  test(`${name} that drains the wallet alerts the owners`, async () => {
    replayed = false;
    balance = -0.25;
    await operation(input);
    await settled();
    expect(zeroAlerts).toEqual([{ accountId: 'acct', balance: -0.25 }]);
  });
  test(`${name} that leaves credit, or a replay, alerts nobody`, async () => {
    replayed = false;
    balance = 3;
    await operation(input);
    replayed = true;
    balance = 0;
    await operation(input);
    await settled();
    expect(zeroAlerts).toEqual([]);
  });
}
