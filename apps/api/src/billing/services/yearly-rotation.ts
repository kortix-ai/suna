import {
  getYearlyAccountsDueForRotation,
  updateCreditAccount,
} from '../repositories/credit-accounts';
import { canonicalTier, getTier, planMonthlyUsd } from './tiers';
import { wallet } from '../wallet';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { ROTATION_BATCH_SIZE } from './rotation-batch';

// STORED TIER ON PURPOSE — do not route this file through the effective-plan
// resolver (billing/services/resolve-billing.ts).
//
// This is a GRANT path: it mints the credits a customer PAID for. The stored
// `credit_accounts.tier` is Stripe's, written by the subscription webhook
// reconciliation, and it is the only column that says what was actually
// charged. The resolver's overlays are entitlement overlays: an admin-issued
// trial lifts what an account may DO for a window without any money changing
// hands. Granting against it would hand out credits nobody paid for, every
// rotation, forever.

export async function processYearlyCreditRotation(): Promise<{
  processed: number;
  skipped: number;
  errors: string[];
}> {
  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  let after: string | undefined;
  for (;;) {
    const accounts = await getYearlyAccountsDueForRotation(after);
    await rotateBatch(accounts);
    if (accounts.length < ROTATION_BATCH_SIZE) break;
    after = accounts[accounts.length - 1]!.accountId;
  }

  async function rotateBatch(accounts: Awaited<ReturnType<typeof getYearlyAccountsDueForRotation>>) {
    for (const account of accounts) {
      try {
        // A paid plan carries its monthly amount on the row; anything else
        // grants its fixed allowance.
        const plan = canonicalTier(account.tier);
        const credits = plan === 'credits' ? planMonthlyUsd(account) : getTier(account.tier ?? 'free').monthlyCredits;
        const now = new Date();
        // UTC, like the free-tier key: a replica in another time zone must not mint a second key at a month edge.
        const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const idempotencyKey = `yearly_rotation_${account.accountId}_${yearMonth}`;

        if (credits > 0) {
          await wallet.reset({
            accountId: account.accountId,
            amount: credits,
            description: `Yearly plan monthly credits: ${Math.round(credits * 100)} credits`,
            key: { event: idempotencyKey },
          });
        }

        const nextGrant = calculateNextCreditGrant(now);
        await updateCreditAccount(account.accountId, {
          nextCreditGrant: nextGrant.toISOString(),
          lastGrantDate: now.toISOString(),
        });

        processed++;
      } catch (err) {
        const msg = `Error processing yearly rotation for ${account.accountId}: ${(err as Error).message}`;
        console.error(`[YearlyRotation] ${msg}`);
        errors.push(msg);
      }
    }
  }

  console.log(`[YearlyRotation] Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors.length}`);
  return { processed, skipped, errors };
}
