import { projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';

/** A role check alone does not bind a caller-supplied project to its route account. */
export async function projectInAccount(accountId: string, projectId: string): Promise<boolean> {
  const rows = await db.select({ projectId: projects.projectId }).from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.projectId, projectId))).limit(1);
  return rows.length > 0;
}
