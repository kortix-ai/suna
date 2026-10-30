import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { db } from '../shared/db';
import { hiddenIamActions } from './registry';

/**
 * The IAM actions an account's permission catalog leaves out: those of every
 * flag that is off in all of the account's projects.
 */
export async function hiddenIamActionsForAccount(accountId: string): Promise<Set<string>> {
  const rows = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.accountId, accountId));
  return hiddenIamActions(rows.map((row) => row.metadata));
}
