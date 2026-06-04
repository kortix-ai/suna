import {
  getYearlyAccountsDueForRotation,
  updateCreditAccount,
} from '../repositories/credit-accounts';
import { getMonthlyCredits } from './tiers';
import { resetExpiringCredits } from './credits';

export async function processYearlyCreditRotation(): Promise<{
  processed: number;
  skipped: number;
  errors: string[];
}> {
  const accounts = await getYearlyAccountsDueForRotation();
  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const account of accounts) {
    try {
      const credits = getMonthlyCredits(account.tier ?? 'free');
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const idempotencyKey = `yearly_rotation_${account.accountId}_${yearMonth}`;

      if (credits > 0) {
        await resetExpiringCredits(
          account.accountId,
          credits,
          `Yearly plan monthly credit rotation: ${credits} credits`,
          idempotencyKey,
        );
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

  console.log(`[YearlyRotation] Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors.length}`);
  return { processed, skipped, errors };
}

export function isYearlyAccountDueForRotation(account: Record<string, any>): boolean {
  if (account.planType !== 'yearly') return false;
  if (!account.tier || account.tier === 'free' || account.tier === 'none') return false;

  if (!account.nextCreditGrant) return true;

  const nextGrant = new Date(account.nextCreditGrant);
  return nextGrant <= new Date();
}

export function calculateNextCreditGrant(from: Date): Date {
  const next = new Date(from);
  const targetMonth = (next.getMonth() + 1) % 12;
  next.setMonth(next.getMonth() + 1);
  // Handle month boundary (e.g., Jan 31 → Feb 28)
  if (next.getMonth() !== targetMonth) {
    next.setDate(0);
  }
  return next;
}
