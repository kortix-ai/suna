/**
 * Which `OVERLAY_FLAGS` are ON for the project of the calling sandbox session.
 * Skill text differs per flag set, so the skill routes and the runtime-assets
 * manifest read this. No session, no project, or any error ⇒ all off.
 */
import { projects, projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { logger } from '../lib/logger';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import { OVERLAY_FLAGS } from './managed-skills';

export async function callerOverlayFlags(c: Context): Promise<string[]> {
  const sessionId = callerKortixSessionId(c);
  if (!sessionId || !isUuid(sessionId)) return [];
  try {
    const [row] = await db
      .select({ metadata: projects.metadata })
      .from(projectSessions)
      .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    return OVERLAY_FLAGS.filter((f) => resolveFeatureFlag(row?.metadata, f));
  } catch (error) {
    logger.warn('[runtime-assets] could not resolve project flags; serving flags-off skills', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
