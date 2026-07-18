import { accountMembers, accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { initializeFreeTierAccount } from '../../billing/services/free-tier';
import { config } from '../../config';
import { syncSignupContactToMailtrap } from '../mailtrap-contacts';
import { db } from '../../shared/db';
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
        console.warn(`[accounts] Failed to initialize free tier for ${userId}:`, err);
      }
    }

    // Only genuinely-new users sync (created:true) — token-authed callers
    // that reach resolveAccount with an existing account never get here.
    // Fire-and-forget: Mailtrap being down must never affect signup.
    void syncSignupContactToMailtrap(email).catch((err) =>
      console.warn(`[accounts] Mailtrap contact sync failed for ${userId}:`, err),
    );

    return { accountId: userId, created: true };
  }

  const [membership] = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(eq(accountMembers.userId, userId))
    .limit(1);

  return { accountId: membership?.accountId ?? userId, created: false };
}
