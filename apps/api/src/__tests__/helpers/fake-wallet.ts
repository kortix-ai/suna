/**
 * In-memory wallet for unit tests of wallet callers. It records every call and
 * answers like a healthy ledger. Replace a method on `wallet` to script a
 * refusal or a failure; `restore()` undoes that and forgets every call.
 *
 *   const fake = createFakeWallet();
 *   mock.module('../billing/wallet', () => ({ wallet: fake.wallet }));
 *   …
 *   expect(fake.calls.grant[0]).toMatchObject({ amount: 50, key: { event: 'in_1' } });
 */
import type {
  DebitInput,
  DebitResult,
  GrantInput,
  GrantResult,
  ResetInput,
  SettleInput,
  SettleResult,
  Wallet,
  WalletBalance,
} from '../../billing/wallet';

export interface FakeWalletCalls {
  grant: GrantInput[];
  debit: DebitInput[];
  settle: SettleInput[];
  reset: ResetInput[];
  forfeit: string[];
}

export function createFakeWallet(options: { balance?: WalletBalance | null } = {}) {
  const calls: FakeWalletCalls = { grant: [], debit: [], settle: [], reset: [], forfeit: [] };
  const healthy: Wallet = {
    grant: async (input): Promise<GrantResult> => {
      calls.grant.push(input);
      return { replayed: false, ledgerId: `ledger_${calls.grant.length}` };
    },
    debit: async (input): Promise<DebitResult> => {
      calls.debit.push(input);
      return { amount: input.amount, balance: 0, transactionId: `tx_${calls.debit.length}`, replayed: false };
    },
    settle: async (input): Promise<SettleResult> => {
      calls.settle.push(input);
      return {
        amount: input.amount,
        balance: 0,
        overdraft: false,
        transactionId: `tx_settle_${calls.settle.length}`,
        replayed: false,
      };
    },
    reset: async (input) => {
      calls.reset.push(input);
    },
    forfeit: async (accountId) => {
      calls.forfeit.push(accountId);
    },
    balance: async () =>
      options.balance === undefined ? { balance: 0, expiring: 0, nonExpiring: 0, daily: 0 } : options.balance,
  };
  const wallet: Wallet = { ...healthy };
  /** Forget every call and undo every scripted method. */
  const restore = () => {
    for (const list of Object.values(calls)) list.length = 0;
    Object.assign(wallet, healthy);
  };
  return { wallet, calls, restore };
}
