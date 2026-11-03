// Agent Drives: `/Agents/<agent>`, one per agent of the project. Who may use
// an agent (`filterAccessibleObjects`, closed by default) reaches its Drive;
// nobody grants it. My Kortix has none (`agentDriveFolder`).

import { projects } from '@kortix/db';
import { isMyKortixAgentName } from '@kortix/shared';
import { eq } from 'drizzle-orm';
import type { Actor } from '../iam/actor';
import { filterAccessibleObjects } from '../iam/authorize';
import { logger } from '../lib/logger';
import { loadProjectAgents } from '../projects/surface';
import { db } from '../shared/db';

/**
 * The project's agents that own a Drive: launchable, not subagent-only, not
 * My Kortix. An unreadable manifest lists none (fails closed: no Agent Drive
 * shows, nothing is granted).
 */
export async function projectDriveAgents(projectId: string): Promise<string[]> {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!row) return [];
  try {
    const { specs } = await loadProjectAgents(row, { rethrowReadErrors: true });
    return specs.filter((s) => s.enabled && !s.subagent && !isMyKortixAgentName(s.name)).map((s) => s.name);
  } catch (err) {
    logger.warn('[drives] agent manifest unreadable; no Agent Drive is listed', {
      projectId,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    return [];
  }
}

/** The agents with a Drive that `actor` may use in the project. */
export async function usableDriveAgents(actor: Actor | null, projectId: string): Promise<string[]> {
  if (!actor) return [];
  const agents = await projectDriveAgents(projectId);
  return filterAccessibleObjects(actor, projectId, 'agent', agents);
}
