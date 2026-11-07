import { eq } from 'drizzle-orm';

import { db } from '../shared/db';
import { hiddenIamActions } from './registry';
import { projectsView } from '../workspaces/rows';

/**
 * The IAM actions an account's permission catalog leaves out: those of every
 * flag that is off in all of the account's projects.
 */
export async function hiddenIamActionsForAccount(accountId: string): Promise<Set<string>> {
  const rows = await db.select({ metadata: projectsView.metadata }).from(projectsView).where(eq(projectsView.accountId, accountId));
  return hiddenIamActions(rows.map((row) => row.metadata));
}
