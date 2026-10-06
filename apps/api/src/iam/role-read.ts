// Read model of roles: `kortix.roles` and `kortix.role_permissions`. Every role
// read outside iam/ goes through here.
//
// Each function returns the query its caller ran inline, unexecuted and
// verbatim (see membership-read.ts): same statements, same order.
import { iamRoleActions, iamRoles } from '@kortix/db';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../shared/db';

/** `{ roleAccountId }` of a role the account may bind: a system role or its own. */
export function bindableRoleRow(roleId: string, accountId: string) {
  return db
    .select({ roleAccountId: iamRoles.accountId })
    .from(iamRoles)
    .where(
      and(eq(iamRoles.roleId, roleId), or(isNull(iamRoles.accountId), eq(iamRoles.accountId, accountId))),
    )
    .limit(1);
}

/** The account's own role row with this id. */
export function customRoleRow(roleId: string, accountId: string) {
  return db
    .select()
    .from(iamRoles)
    .where(and(eq(iamRoles.roleId, roleId), eq(iamRoles.accountId, accountId)))
    .limit(1);
}

/** Every custom role of the account. */
export function accountCustomRoles(accountId: string) {
  return db.select().from(iamRoles).where(eq(iamRoles.accountId, accountId));
}

/** Key, name, description and scope of every seeded system role. */
export function systemRoleDescriptionRows() {
  return db
    .select({
      key: iamRoles.key,
      name: iamRoles.name,
      description: iamRoles.description,
      scopeType: iamRoles.scopeType,
    })
    .from(iamRoles)
    .where(isNull(iamRoles.accountId));
}

/** The actions a role grants. */
export function roleActionRows(roleId: string) {
  return db.select({ action: iamRoleActions.action }).from(iamRoleActions).where(eq(iamRoleActions.roleId, roleId));
}
