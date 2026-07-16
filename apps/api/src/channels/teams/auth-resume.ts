import { and, eq, gt, lt } from 'drizzle-orm';
import { chatPendingAuthMessages } from '@kortix/db';
import { db } from '../../shared/db';
import type { TeamsActivity } from './types';

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export async function createPendingTeamsAuthMessage(input: {
  projectId: string;
  tenantId: string;
  teamsUserId: string;
  activity: TeamsActivity;
}): Promise<string | null> {
  if (!input.tenantId || !input.teamsUserId) return null;
  try {
    await db.delete(chatPendingAuthMessages).where(lt(chatPendingAuthMessages.expiresAt, new Date()));
    const rows = await db
      .insert(chatPendingAuthMessages)
      .values({
        projectId: input.projectId,
        platform: 'teams',
        workspaceId: input.tenantId,
        platformUserId: input.teamsUserId,
        envelope: {},
        event: input.activity as unknown as Record<string, unknown>,
        expiresAt: new Date(Date.now() + PENDING_AUTH_TTL_MS),
      })
      .returning({ pendingId: chatPendingAuthMessages.pendingId });
    return rows[0]?.pendingId ?? null;
  } catch (err) {
    console.warn('[teams-auth] failed to store pending Teams message', err);
    return null;
  }
}

export async function consumePendingTeamsAuthMessage(input: {
  pendingId: string | undefined;
  tenantId: string;
  teamsUserId: string;
}): Promise<{ projectId: string; activity: TeamsActivity } | null> {
  if (!input.pendingId || !input.tenantId || !input.teamsUserId) return null;
  try {
    const [row] = await db
      .select({
        projectId: chatPendingAuthMessages.projectId,
        event: chatPendingAuthMessages.event,
      })
      .from(chatPendingAuthMessages)
      .where(
        and(
          eq(chatPendingAuthMessages.pendingId, input.pendingId),
          eq(chatPendingAuthMessages.workspaceId, input.tenantId),
          eq(chatPendingAuthMessages.platformUserId, input.teamsUserId),
          gt(chatPendingAuthMessages.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) return null;
    await db.delete(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.pendingId, input.pendingId));
    return { projectId: row.projectId, activity: row.event as unknown as TeamsActivity };
  } catch (err) {
    console.warn('[teams-auth] failed to consume pending Teams message', err);
    return null;
  }
}
