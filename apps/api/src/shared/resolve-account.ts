import { eq } from 'drizzle-orm';
import { accounts, accountMembers, accountUser } from '@kortix/db';
import { db } from './db';

async function syncLegacySubscription(accountId: string): Promise<void> {
  const { syncLegacyStripeSubscription } = await import('../billing/services/legacy-stripe-sync');
  const result = await syncLegacyStripeSubscription(accountId);
  if (result.status === 'error') {
    console.warn(`[resolve-account] Stripe sync error for ${accountId}: ${result.error}`);
  }
}

export async function resolveAccountId(userId: string): Promise<string> {
  try {
    const [membership] = await db
      .select({ accountId: accountMembers.accountId })
      .from(accountMembers)
      .where(eq(accountMembers.userId, userId))
      .limit(1);

    if (membership) {
      await syncLegacySubscription(membership.accountId);
      return membership.accountId;
    }
  } catch { }

  try {
    const [legacy] = await db
      .select({ accountId: accountUser.accountId })
      .from(accountUser)
      .where(eq(accountUser.userId, userId))
      .limit(1);

    if (legacy) {
      try {
        await db.insert(accounts).values({
          accountId: legacy.accountId,
          name: 'Personal',
          personalAccount: true,
        }).onConflictDoNothing();

        await db.insert(accountMembers).values({
          userId,
          accountId: legacy.accountId,
          accountRole: 'owner',
        }).onConflictDoNothing();

        console.log(`[resolve-account] Lazy-migrated basejump account ${legacy.accountId} for user ${userId}`);
      } catch (migErr) {
        console.warn(`[resolve-account] Lazy migration failed for ${legacy.accountId}:`, migErr);
      }

      await syncLegacySubscription(legacy.accountId);

      return legacy.accountId;
    }
  } catch { }

  try {
    await db.insert(accounts).values({
      accountId: userId,
      name: 'Personal',
      personalAccount: true,
    }).onConflictDoNothing();

    await db.insert(accountMembers).values({
      userId,
      accountId: userId,
      accountRole: 'owner',
    }).onConflictDoNothing();
  } catch { }

  return userId;
}
