import { eq } from 'drizzle-orm';
import { accounts, accountMembers, accountUser } from '@kortix/db';
import { db } from './db';
import { claimPendingInvitesOnSignup } from '../teams';

async function syncLegacySubscription(accountId: string): Promise<void> {
  const { syncLegacyStripeSubscription } = await import('../billing/services/legacy-stripe-sync');
  const result = await syncLegacyStripeSubscription(accountId);
  if (result.status === 'error') {
    console.warn(`[resolve-account] Stripe sync error for ${accountId}: ${result.error}`);
  }
}

async function getUserEmail(userId: string): Promise<string | null> {
  try {
    const { getSupabase } = await import('./supabase');
    const { data, error } = await getSupabase().auth.admin.getUserById(userId);
    if (error) return null;
    return data?.user?.email?.trim().toLowerCase() ?? null;
  } catch {
    return null;
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

  // First-time signup. Before creating a personal account, check for pending
  // sandbox invites — if any, join the inviter's account directly so the user
  // has a single primary account that already has the shared workspace in it.
  const email = await getUserEmail(userId);
  if (email) {
    const claimedAccountId = await claimPendingInvitesOnSignup(db, userId, email);
    if (claimedAccountId) {
      await syncLegacySubscription(claimedAccountId);
      return claimedAccountId;
    }
  }

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
