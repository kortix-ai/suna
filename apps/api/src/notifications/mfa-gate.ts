// May this sign-in see an account's notification content (KRTX-1742)? The
// same answer `authorize` gives: an account that requires MFA blocks a browser
// sign-in below aal2 (`mfaGateBlocks`, step 6), except for the account's super
// admins (step 5, above the gate, so an MFA switch never locks an account
// out). The inbox read and Web Push both use it, so a person the app lets in
// at aal1 also gets the bell rows and the pushes.
import { accounts } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { mfaGateBlocks } from '../iam/authorize';
import { superAdminAccountIds } from '../iam/membership-read';
import { db } from '../shared/db';

export interface MfaSignIn {
  /** A token's id: a token has no second factor, and the gate never blocks it. */
  iamTokenId?: string | null;
  mfaAal?: string | null;
}

/** The accounts among `accountIds` whose content `userId` may not see from `signIn`. */
export async function mfaWithheldAccounts(
  userId: string,
  accountIds: readonly string[],
  signIn: MfaSignIn,
): Promise<Set<string>> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ accountId: accounts.accountId, mfaRequired: accounts.mfaRequired })
    .from(accounts)
    .where(inArray(accounts.accountId, ids));
  const gated = rows
    .filter((row) => mfaGateBlocks({ accountMfaRequired: row.mfaRequired }, signIn.iamTokenId, signIn.mfaAal ?? undefined))
    .map((row) => row.accountId);
  if (gated.length === 0) return new Set();
  const exempt = await superAdminAccountIds(userId, gated);
  return new Set(gated.filter((accountId) => !exempt.has(accountId)));
}
