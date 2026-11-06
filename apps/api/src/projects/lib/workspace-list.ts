/**
 * The rows behind `GET /v1/workspaces` (design.md §3.2 C5): every active
 * project row of a set of accounts, in one query. The route composes them
 * with the caller's access per account (`routes/workspace-records.ts`).
 */
import { projects } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../../shared/db';

export type WorkspaceProjectRow = typeof projects.$inferSelect;

/** Every active project of `accountIds`. `[]` for no account (no query). */
export async function activeProjectsOfAccounts(accountIds: readonly string[]): Promise<WorkspaceProjectRow[]> {
  if (accountIds.length === 0) return [];
  return db
    .select()
    .from(projects)
    .where(and(inArray(projects.accountId, [...accountIds]), eq(projects.status, 'active')));
}

/**
 * The list order of every workspace list: most recently opened first (never
 * opened last), then by name, then by id. Pure: exported for tests.
 */
export function compareWorkspaceRows(
  a: { lastOpenedAt: Date | null; name: string; projectId: string },
  b: { lastOpenedAt: Date | null; name: string; projectId: string },
): number {
  const at = a.lastOpenedAt?.getTime() ?? null;
  const bt = b.lastOpenedAt?.getTime() ?? null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at;
  }
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
}
