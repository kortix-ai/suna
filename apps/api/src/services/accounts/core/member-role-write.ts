import { assignRole, type Writer } from '../../iam/assignments';
import type { AccountRole } from './account-name';

/**
 * The canonical half of an account-membership write.
 *
 * `account_members` is still written by these routes (a pre-cutover replica
 * reads it, and the mirror trigger derives the assignment from it), but the
 * ASSIGNMENT is what the engine reads, so every membership mutation goes
 * through `assignRole` / the revoke audit as well. Doing both is safe: the
 * trigger's upsert and `assignRole`'s upsert target the same identity index, so
 * the pair produces exactly ONE row.
 */
export async function grantAccountRole(
  writer: Writer,
  accountId: string,
  userId: string,
  role: AccountRole,
): Promise<void> {
  // THE write. `account_members.account_role` is a derived view column as of the
  // cutover — there is no second store to keep in step, so a failure here is a
  // failure of the membership change and must propagate.
  //
  // `exclusive` reproduces what the single `account_role` COLUMN enforced: one
  // system account role per member, so owner -> admin retracts the owner
  // assignment instead of unioning with it.
  await assignRole(writer, accountId, {
    principal: { type: 'user', id: userId },
    roleKey: role,
    scope: { type: 'account' },
    source: 'system',
    exclusive: true,
  });
}
