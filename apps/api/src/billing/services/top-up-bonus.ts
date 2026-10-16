import { wallet } from '../wallet';
import { topUpBonusUsd } from './tiers';

/** Ledger type of the bonus row: a grant, not a purchase, so lifetime purchased stays what was paid. */
export const TOP_UP_BONUS_LEDGER_TYPE = 'topup_bonus';

/**
 * Grant the bonus a paid top-up of `amountUsd` earns. Keyed on the payment, so a
 * redelivered webhook replays. No-op below the first bonus step.
 */
export async function grantTopUpBonus(accountId: string, amountUsd: number, key: string): Promise<number> {
  const bonus = topUpBonusUsd(amountUsd);
  if (bonus <= 0) return 0;
  await wallet.grant({
    accountId,
    amount: bonus,
    kind: TOP_UP_BONUS_LEDGER_TYPE,
    description: `Top-up bonus: ${Math.round(bonus * 100)} credits on a $${amountUsd.toFixed(2)} top-up`,
    expiring: false,
    key: { event: key },
  });
  return bonus;
}
