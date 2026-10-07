import { wallet } from '../wallet';
import type { DebitInput, SettleInput } from '../wallet';
import { checkAndTriggerAutoTopup } from './auto-topup';

// Keep the check after a successful wallet result (including a replay), but
// do not wait for the Stripe charge before returning the billing result.
export async function debitAndCheckAutoTopup(input: DebitInput) {
  const result = await wallet.debit(input);
  void checkAndTriggerAutoTopup(input.accountId);
  return result;
}

export async function settleAndCheckAutoTopup(input: SettleInput) {
  const result = await wallet.settle(input);
  void checkAndTriggerAutoTopup(input.accountId);
  return result;
}
