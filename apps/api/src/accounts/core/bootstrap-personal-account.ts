import { accountMembers, accountMemberships, accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { initializeFreeTierAccount } from '../../billing/services/free-tier';
import { config } from '../../lib/config';
import { syncSignupContactToMailtrap } from '../mailtrap-contacts';
import { assignRole, SYSTEM_ACTOR } from '../../iam/assignments';
import { db } from '../../lib/db';
import { getSupabase } from '../../lib/supabase';
import { profileNameFromMetadata } from './account-name';
import { defaultAccountName } from './app';

/**
 * The sign-in profile's name (Google/GitHub OAuth fill `full_name` / `name`).
 * Best effort: a miss only means the suggestion falls back to the email.
 */
async function profileName(userId: string): Promise<string | null> {
  try {
    const { data } = await getSupabase().auth.admin.getUserById(userId);
    return profileNameFromMetadata(data?.user?.user_metadata);
  } catch {
    return null;
  }
}

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
  /** Pass it when the caller already has the auth user; `undefined` looks it up. */
  fullName?: string | null,
  lookupProfileName: (userId: string) => Promise<string | null> = profileName,
): Promise<{ accountId: string; created: boolean }> {
  // Never `"<email>'s Account"` (KRTX-638): a suggested name the user confirms
  // or changes on their first project (`/new`).
  const name = defaultAccountName(
    email,
    fullName === undefined ? await lookupProfileName(userId) : fullName,
  );

  const created = await db
    .insert(accounts)
    .values({
      accountId: userId,
      name,
    })
    .onConflictDoNothing()
    .returning({ accountId: accounts.accountId });

  if (created.length > 0) {
    // IDENTITY, then the OWNER role. `SYSTEM_ACTOR`: the platform is the writer
    // here — there is no one to authorize, the account is being created FOR this
    // user.
    await db
      .insert(accountMemberships)
      .values({ userId, accountId: userId, isSuperAdmin: true })
      .onConflictDoNothing();
    await assignRole(SYSTEM_ACTOR, userId, {
      principal: { type: 'user', id: userId },
      roleKey: 'owner',
      scope: { type: 'account' },
      source: 'system',
      exclusive: true,
    });

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
