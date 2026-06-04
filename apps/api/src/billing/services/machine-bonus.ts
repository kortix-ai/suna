import { grantCredits } from './credits';
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

  return grantCredits(
    accountId,
    MACHINE_CREDIT_BONUS,
    'machine_bonus',
    description,
    false,
    idempotencyKey,
  );
}

export function getStripeMachineBonusKey(subscriptionId: string) {
  return `machine_bonus:subscription:${subscriptionId}`;
}

export function getLegacyClaimMachineBonusKey(accountId: string) {
  return `machine_bonus:legacy_claim:${accountId}`;
}
