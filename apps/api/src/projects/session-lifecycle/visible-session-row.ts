import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

export async function reloadVisibleSessionRow(sessionId: string) {
  const [fresh] = await db
    .select({
      status: projectSessions.status,
      sandboxProvider: projectSessions.sandboxProvider,
      baseRef: projectSessions.baseRef,
      agentName: projectSessions.agentName,
      opencodeSessionId: projectSessions.opencodeSessionId,
      accountId: projectSessions.accountId,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return fresh ?? null;
}
