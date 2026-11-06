// The agents a person may use, for shared Drives (`shared_drives`): a Drive
// added to one of them reaches the person. Who may use an agent is IAM
// (`filterAccessibleObjects`, closed by default).

import { eq } from 'drizzle-orm';
import type { Actor } from '../iam/actor';
import { filterAccessibleObjects } from '../iam/authorize';
import { logger } from '../lib/logger';
import { loadProjectAgents } from '../projects/surface';
import { db } from '../shared/db';
import { projectsView } from '../workspaces/rows';

/**
 * The project's launchable agents (not subagent-only). An unreadable
 * manifest lists none (fails closed: no shared Drive reaches anyone).
 */
export async function projectDriveAgents(projectId: string): Promise<string[]> {
  const [row] = await db.select().from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  if (!row) return [];
  try {
    const { specs } = await loadProjectAgents(row, { rethrowReadErrors: true });
    return specs.filter((s) => s.enabled && !s.subagent).map((s) => s.name);
  } catch (err) {
    logger.warn('[drives] agent manifest unreadable; no shared Drive reaches a person through an agent', {
      projectId,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return [];
  }
}

/** The project's agents `actor` may use. */
export async function usableDriveAgents(actor: Actor | null, projectId: string): Promise<string[]> {
  if (!actor) return [];
  const agents = await projectDriveAgents(projectId);
  return filterAccessibleObjects(actor, projectId, 'agent', agents);
}
