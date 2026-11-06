import { accountMemberships } from '@kortix/db';

import { claimFirstWorkspaceFreeCredits } from '../../billing/services/free-credit-claims';
import { initializeFreeTierAccount } from '../../billing/services/free-tier';
import { config } from '../../config';
import { assignRole, SYSTEM_ACTOR } from '../../iam/assignments';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { syncSignupContactToMailtrap } from '../mailtrap-contacts';
import { insertAccountRow, type AccountRow } from '../../workspaces/rows';

export type CreatedAccountRow = AccountRow;

/**
 * Create an account and make `userId` its owner. The ONE place an account is
 * born: `POST /v1/accounts`, a new workspace (`POST /v1/projects/provision`
 * with `new_workspace: true`) and the self-host owner bootstrap all call it.
 * Nothing creates an account implicitly (Workspaces D3, 2026-11-05).
 *
 * Steps, in order:
 *   1. the `accounts` row;
 *   2. the owner's `account_members` row (identity) and the `owner` role
 *      (`role_assignments`, what the engine reads). `SYSTEM_ACTOR`: nobody
 *      holds a permission in an account that did not exist a statement ago,
 *      so creating it is the authorization;
 *   3. the free tier, when internal billing is on: the free signup credits
 *      only on the person's first workspace (`claimFirstWorkspaceFreeCredits`),
 *      else Free with 0 credits. Best effort: the billing gates repair a
 *      missing wallet row on first use (`ensureFreeTierAccountReady`);
 *   4. the creator's Mailtrap contact, fire-and-forget. The sync is an
 *      idempotent upsert, so a second workspace re-syncs the same contact.
 */
export async function createOwnedAccount(input: {
  userId: string;
  name: string;
  email?: string | null;
}): Promise<CreatedAccountRow> {
  const { userId, name, email } = input;
  const account = await insertAccountRow({ name });

  await db.insert(accountMemberships).values({
    userId,
    accountId: account.accountId,
    isSuperAdmin: true,
  });
  await assignRole(SYSTEM_ACTOR, account.accountId, {
    principal: { type: 'user', id: userId },
    roleKey: 'owner',
    scope: { type: 'account' },
    source: 'system',
    exclusive: true,
  });

  if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
    try {
      // One free grant per person: only their first workspace gets credits.
      const freeCredits = await claimFirstWorkspaceFreeCredits(userId, account.accountId);
      await initializeFreeTierAccount(account.accountId, { freeCredits });
    } catch (err) {
      logger.warn('[accounts] Failed to initialize free tier', {
        accountId: account.accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (email) {
    void syncSignupContactToMailtrap(email).catch((err) =>
      logger.warn('[accounts] Mailtrap contact sync failed', {
        accountId: account.accountId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return account;
}
