import type { Effect } from 'effect';
import { accountMembers, accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { initializeFreeTierAccount } from '../../billing/services/free-tier';
import { accountConfig as config } from '../effect';
import { accountDb as db } from '../effect';
import { defaultAccountName } from './app';

/**
 * Idempotent personal-account bootstrap for a new auth user.
 *
 * Personal accounts use `accountId === userId` so resolveAccountId and
 * GET /v1/accounts converge on the same row instead of racing to create
 * two different accounts (random UUID vs user id).
 */
export async function bootstrapPersonalAccount(
  userId: string,
  email?: string | null,
): Promise<{ accountId: string; created: boolean }> {
  const name = defaultAccountName(email);

  const created = await db
    .insert(accounts)
    .values({
      accountId: userId,
      name,
    })
    .onConflictDoNothing()
    .returning({ accountId: accounts.accountId });

  if (created.length > 0) {
    await db
      .insert(accountMembers)
      .values({
        userId,
        accountId: userId,
        accountRole: 'owner',
        isSuperAdmin: true,
      })
      .onConflictDoNothing();

    if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
      try {
        await initializeFreeTierAccount(userId);
      } catch (err) {
        console.warn(
          `[accounts] Failed to initialize free tier for ${userId}:`,
          err,
        );
      }
    }

    return { accountId: userId, created: true };
  }

  const [membership] = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(eq(accountMembers.userId, userId))
    .limit(1);

  return { accountId: membership?.accountId ?? userId, created: false };
}
