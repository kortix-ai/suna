import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../../shared/db';

/**
 * The Kortix agent a session runs, as channel replies name it. Every channel
 * session stores the agent it launched with (the channel's pick, else the
 * project default). Null before the session exists or for a blank name.
 */
export async function sessionAgentName(sessionId: string | null | undefined): Promise<string | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select({ agentName: projectSessions.agentName })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return row?.agentName?.trim() || null;
}
