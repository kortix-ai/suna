import { projectSessions } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../shared/db';
import { sessionTitleFromMetadata } from './session-title-placeholder';

/** The session fields the asks routes read: who may decide, where it shows, what it is called. */
export interface AskSessionRow {
  sessionId: string;
  createdBy: string | null;
  origin: string | null;
  spaceId: string | null;
  title: string | null;
}

/** The project's sessions among `sessionIds`, by id. */
export async function readAskSessions(projectId: string, sessionIds: readonly string[]): Promise<Map<string, AskSessionRow>> {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      sessionId: projectSessions.sessionId,
      createdBy: projectSessions.createdBy,
      origin: projectSessions.origin,
      spaceId: projectSessions.spaceId,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), inArray(projectSessions.sessionId, ids)));
  return new Map(
    rows.map(({ metadata, ...row }) => {
      return [row.sessionId, { ...row, title: sessionTitleFromMetadata(metadata) }];
    }),
  );
}
