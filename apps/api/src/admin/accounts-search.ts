import { accounts } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';
import { accountIdsWithMemberEmailLikeSql } from '../iam/membership-read';
import { qualifiedColumn } from '../shared/sql-qualified-column';

/**
 * The `search` filter of the admin accounts list: the account's name or any
 * member's email contains the term (case-insensitive). Shared by the list
 * query and its count query in `./index.ts`.
 *
 * The email branch is resolved users-first BY FORCE. A plain
 * `EXISTS (SELECT 1 FROM auth.users au INNER JOIN kortix.account_members am …)`
 * lets the planner resolve it the other way around: scan every
 * account_memberships row and probe auth.users by primary key per membership.
 * On prod that is ~46k random probes into a ~472 MB heap on every search call
 * (mean 3978 ms over 47 calls, KRTX-1127; 45 s measured cold). The LATERAL +
 * `offset 0` fence pins the join order: one sequential pass over auth.users
 * with the ILIKE filter, then one `account_members_pkey` probe per matching
 * user. The fence stays correct if a trigram index on auth.users(email) lands
 * later: the users side then serves the same ILIKE from the index instead of a
 * sequential scan.
 */
export function adminAccountsSearchCondition(search: string): SQL {
  const pattern = `%${search}%`;
  return sql`(${qualifiedColumn(accounts.name)} ilike ${pattern} or ${qualifiedColumn(accounts.accountId)} IN (
    ${accountIdsWithMemberEmailLikeSql(pattern)}))`;
}
