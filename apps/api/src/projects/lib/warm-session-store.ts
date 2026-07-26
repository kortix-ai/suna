import { projectSessions } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ProjectSessionRow } from './serializers';

const availableWarmSession = sql`
  ${projectSessions.metadata}->'warm_session'->>'state' = 'available'
`;
const notDeleted = sql`
  coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''
`;

export interface WarmProjectSessionScope {
  accountId: string;
  projectId: string;
  userId: string;
}

export async function findAvailableWarmProjectSession(
  scope: WarmProjectSessionScope,
): Promise<ProjectSessionRow | null> {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.accountId, scope.accountId),
        eq(projectSessions.projectId, scope.projectId),
        eq(projectSessions.createdBy, scope.userId),
        availableWarmSession,
        notDeleted,
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function discardAvailableWarmProjectSession(
  scope: WarmProjectSessionScope,
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .update(projectSessions)
    .set({ metadata, updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.accountId, scope.accountId),
        eq(projectSessions.projectId, scope.projectId),
        eq(projectSessions.createdBy, scope.userId),
        eq(projectSessions.sessionId, sessionId),
        availableWarmSession,
      ),
    );
}

export async function claimAvailableWarmProjectSession(
  scope: WarmProjectSessionScope,
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<ProjectSessionRow | null> {
  const [row] = await db
    .update(projectSessions)
    .set({ metadata, updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.accountId, scope.accountId),
        eq(projectSessions.projectId, scope.projectId),
        eq(projectSessions.createdBy, scope.userId),
        eq(projectSessions.sessionId, sessionId),
        availableWarmSession,
        notDeleted,
      ),
    )
    .returning();
  return row ?? null;
}
