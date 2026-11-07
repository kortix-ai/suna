import { freeCreditClaims } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { accountRolesForUser } from '../../iam/read-models';
import { db } from '../../shared/db';
import { workspaceIdOfAccount } from '../../workspaces/surface';

/**
 * The workspace that holds `userId`'s free credits (`kortix.free_credit_claims`,
 * one row per person), as its workspace id. Null when the person holds no
 * claim (a legacy person whose sign-up account held the grant), when they are
 * no longer a member of that workspace, or when it has no single live id.
 * The account-state route reports it as `credits.free_grant.claimed_workspace_id`.
 */
export async function claimedFreeGrantWorkspace(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [claim] = await db
    .select({ accountId: freeCreditClaims.accountId })
    .from(freeCreditClaims)
    .where(eq(freeCreditClaims.userId, userId))
    .limit(1);
  if (!claim) return null;
  const roles = await accountRolesForUser(userId);
  if (!roles.has(claim.accountId)) return null;
  return workspaceIdOfAccount(claim.accountId);
}
