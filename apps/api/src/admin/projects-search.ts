import { accounts, projects } from '@kortix/db';
import { ilike, or, sql } from 'drizzle-orm';
import { accountIdsWithMemberEmailLikeSql } from '../iam/membership-read';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { escapeLike } from '../shared/sql-like';

/** Shared search predicate for the fleet projects page and its filtered count. */
export function adminProjectsSearchCondition(search: string) {
  const pattern = `%${escapeLike(search)}%`;
  return or(
    ilike(projects.name, pattern),
    ilike(accounts.name, pattern),
    sql`${qualifiedColumn(projects.accountId)} IN (${accountIdsWithMemberEmailLikeSql(pattern)})`,
  );
}
