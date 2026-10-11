import { wallet } from '../wallet';
import type { DebitInput, SettleInput } from '../wallet';
import { logger } from '../../lib/logger';
import { checkAndTriggerAutoTopup } from './auto-topup';

// Keep the check after a successful wallet result (including a replay), but
// do not wait for the Stripe charge before returning the billing result.
export async function debitAndCheckAutoTopup(input: DebitInput) {
  const result = await wallet.debit(input);
  void checkAndTriggerAutoTopup(input.accountId);
  alertIfDrained(input.accountId, result);
  return result;
}

export async function settleAndCheckAutoTopup(input: SettleInput) {
  const result = await wallet.settle(input);
  void checkAndTriggerAutoTopup(input.accountId);
  alertIfDrained(input.accountId, result);
  return result;
}

/**
 * A debit that left the wallet at $0 or below tells the owners (KRTX-1718).
 * Not on a replay, whose balance is not this debit's. Fire-and-forget, and
 * lazy, so the billing result never waits on email.
 */
function alertIfDrained(accountId: string, result: { balance?: number; replayed?: boolean }): void {
  if (result.replayed || typeof result.balance !== 'number' || result.balance > 0) return;
  const balance = result.balance;
  void import('./wallet-zero-alert')
    .then((alert) => alert.alertWalletAtZero(accountId, balance))
    .catch((err: unknown) =>
      logger.warn('[Wallet] zero-balance alert failed', { accountId, error: err instanceof Error ? err.message : String(err) }),
    );
}
