import { wallet } from '../wallet';
import { MACHINE_CREDIT_BONUS } from './tiers';

interface GrantMachineBonusOnceParams {
  accountId: string;
  idempotencyKey: string;
  description?: string;
}

export async function grantMachineBonusOnce(params: GrantMachineBonusOnceParams) {
  const {
    accountId,
    idempotencyKey,
    description = `Machine credit bonus: $${MACHINE_CREDIT_BONUS}`,
  } = params;

  if (MACHINE_CREDIT_BONUS <= 0) {
    return { success: true, skipped: true };
  }

  return wallet.grant({
    accountId,
    amount: MACHINE_CREDIT_BONUS,
    kind: 'machine_bonus',
    description,
    expiring: false,
    key: { event: idempotencyKey },
  });
}

export function getStripeMachineBonusKey(subscriptionId: string) {
  return `machine_bonus:subscription:${subscriptionId}`;
}
