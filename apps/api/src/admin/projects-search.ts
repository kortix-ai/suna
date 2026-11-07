import { ilike, or, sql } from 'drizzle-orm';
import { accountIdsWithMemberEmailLikeSql } from '../iam/membership-read';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { escapeLike } from '../shared/sql-like';
import { accountsView, projectsView } from '../workspaces/rows';

/** Shared search predicate for the fleet projects page and its filtered count. */
export function adminProjectsSearchCondition(search: string) {
  const pattern = `%${escapeLike(search)}%`;
  return or(
    ilike(projectsView.name, pattern),
    ilike(accountsView.name, pattern),
    sql`${qualifiedColumn(projectsView.accountId)} IN (${accountIdsWithMemberEmailLikeSql(pattern)})`,
  );
}
