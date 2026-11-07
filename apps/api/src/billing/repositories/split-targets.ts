import { workspaceSplitRuns } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { db } from '../../shared/db';

/**
 * True when `accountId` is the account a workspace split created for a
 * project (`workspace_split_runs.to_account_id`). Such an account never gets
 * the free signup grant: the person already holds it in their first
 * workspace (one free grant per person).
 */
export async function isWorkspaceSplitTarget(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ runId: workspaceSplitRuns.runId })
    .from(workspaceSplitRuns)
    .where(eq(workspaceSplitRuns.toAccountId, accountId))
    .limit(1);
  return Boolean(row);
}
