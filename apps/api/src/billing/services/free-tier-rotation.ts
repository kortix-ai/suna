import type { CreditAccount } from '@kortix/db';
import {
  getFreeAccountsDueForRotation,
  updateCreditAccount,
} from '../repositories/credit-accounts';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { resetExpiringCredits } from './credits';

const FREE_TIER_MONTHLY_CREDITS_USD = 2;

function rotationMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function processFreeTierCreditRotation(now = new Date()): Promise<{
  processed: number;
  skipped: number;
  errors: string[];
}> {
  const accounts = await getFreeAccountsDueForRotation();
  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const account of accounts) {
    if (!isFreeTierAccountDueForRotation(account, now)) {
      skipped++;
      continue;
    }

    try {
      const idempotencyKey = `free_tier_rotation_${account.accountId}_${rotationMonth(now)}`;
      await resetExpiringCredits(
        account.accountId,
        FREE_TIER_MONTHLY_CREDITS_USD,
        `Free tier monthly credit reset: ${FREE_TIER_MONTHLY_CREDITS_USD} credits`,
        idempotencyKey,
      );

      await updateCreditAccount(account.accountId, {
        nextCreditGrant: calculateNextCreditGrant(now).toISOString(),
        lastGrantDate: now.toISOString(),
      });

      processed++;
    } catch (err) {
      const msg = `Error processing free-tier rotation for ${account.accountId}: ${(err as Error).message}`;
      console.error(`[FreeTierRotation] ${msg}`);
      errors.push(msg);
    }
  }

  console.log(
    `[FreeTierRotation] Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors.length}`,
  );
  return { processed, skipped, errors };
}

export function isFreeTierAccountDueForRotation(
  account: Pick<CreditAccount, 'tier' | 'nextCreditGrant'>,
  now = new Date(),
): boolean {
  if (account.tier !== 'free') return false;
  if (!account.nextCreditGrant) return true;

  const nextGrant = new Date(account.nextCreditGrant);
  return nextGrant <= now;
}
