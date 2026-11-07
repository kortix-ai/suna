import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { projectsView } from '../workspaces/rows';

/** A role check alone does not bind a caller-supplied project to its route account. */
export async function projectInAccount(accountId: string, projectId: string): Promise<boolean> {
  const rows = await db.select({ projectId: projectsView.projectId }).from(projectsView)
    .where(and(eq(projectsView.accountId, accountId), eq(projectsView.projectId, projectId))).limit(1);
  return rows.length > 0;
}
