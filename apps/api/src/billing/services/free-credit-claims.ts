import { freeCreditClaims } from '@kortix/db';

import { accountRolesForUser } from '../../iam/read-models';
import { db } from '../../shared/db';

/**
 * Does the workspace `accountId`, just created by `userId`, get the free
 * signup credits? One free grant per person (Workspaces, 2026-11-05):
 *
 * - The person's FIRST workspace gets it. "First" is recorded in
 *   `kortix.free_credit_claims` (primary key `user_id`): the insert wins once
 *   per person, ever. The row has no foreign key, so it outlives the account;
 *   deleting a workspace and creating another never grants twice.
 * - A person who already owns another account (every account that existed
 *   before this rule: their sign-up personal account held the grant) is past
 *   their first workspace. No claim is written for them.
 *
 * Call it after the owner role is assigned. Billing off (self-host) never
 * calls it.
 */
export async function claimFirstWorkspaceFreeCredits(userId: string, accountId: string): Promise<boolean> {
  const roles = await accountRolesForUser(userId);
  const ownsAnother = [...roles].some(([id, role]) => role === 'owner' && id !== accountId);
  if (ownsAnother) return false;
  const claimed = await db
    .insert(freeCreditClaims)
    .values({ userId, accountId })
    .onConflictDoNothing()
    .returning({ userId: freeCreditClaims.userId });
  return claimed.length > 0;
}
