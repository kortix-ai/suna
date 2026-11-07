import { freeCreditClaims } from '@kortix/db';
import { sql } from 'drizzle-orm';

import { accountRolesForUser } from '../../iam/read-models';
import { db } from '../../shared/db';

/**
 * Does the workspace `accountId`, just created by `userId`, get the free
 * signup credits? One free grant per person (Workspaces, 2026-11-05;
 * design.md §3.2 C6):
 *
 * - The person's FIRST workspace gets it. "First" is recorded in
 *   `kortix.free_credit_claims` (primary key `user_id`): the insert wins once
 *   per person, ever. The row has no foreign key, so it outlives the account;
 *   deleting a workspace and creating another never grants twice.
 * - Another account the person owns counts as an earlier workspace only when
 *   it has a project row (any status) or pays (`kortix.account_is_paying`).
 *   A dormant sign-up account from before Workspaces D3 (no project, Free, no
 *   purchase) is not a workspace the person ever used: a legacy person whose
 *   only account is that one gets the grant on their first created workspace.
 *
 * Call it after the owner role is assigned. Billing off (self-host) never
 * calls it.
 */
export async function claimFirstWorkspaceFreeCredits(userId: string, accountId: string): Promise<boolean> {
  const roles = await accountRolesForUser(userId);
  const others = [...roles].filter(([id, role]) => role === 'owner' && id !== accountId).map(([id]) => id);
  if (others.length > 0) {
    const [used] = await db.execute<{ hit: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM (SELECT jsonb_array_elements_text(${JSON.stringify(others)}::jsonb)::uuid AS id) a
         WHERE EXISTS (SELECT 1 FROM kortix.projects p WHERE p.account_id = a.id)
            OR kortix.account_is_paying(a.id)) AS hit`);
    if (used?.hit) return false;
  }
  const claimed = await db
    .insert(freeCreditClaims)
    .values({ userId, accountId })
    .onConflictDoNothing()
    .returning({ userId: freeCreditClaims.userId });
  return claimed.length > 0;
}
