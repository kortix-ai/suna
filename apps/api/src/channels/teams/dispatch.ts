import { and, eq, lt } from 'drizzle-orm';
import { chatEventDedup, chatInstalls } from '@kortix/db';
import { db } from '../../shared/db';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { createOrJoinTeamsConversationSession } from './session';
import type { TeamsActivity } from './types';

export function tenantOf(activity: TeamsActivity): string | null {
  return activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? null;
}

export function isActionableMessage(activity: TeamsActivity): boolean {
  if (activity.type !== 'message') return false;
  if (!activity.text || !activity.text.trim()) return false;
  if (!activity.conversation?.id || !activity.serviceUrl || !activity.id) return false;
  return true;
}

async function alreadyHandled(activityId: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId: `teams:event:${activityId}`, expiresAt: new Date(Date.now() + EVENT_DEDUPE_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length === 0;
  } catch (err) {
    console.warn('[teams-webhook] dedup insert failed (fail-open)', err);
    return false;
  }
}

async function resolveProjectForTenant(tenantId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'teams'), eq(chatInstalls.workspaceId, tenantId)))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

export async function handleTeamsActivity(activity: TeamsActivity): Promise<void> {
  if (!isActionableMessage(activity)) return;

  const tenantId = tenantOf(activity);
  if (!tenantId) {
    console.warn('[teams-webhook] activity has no tenant — ignoring', { activityId: activity.id });
    return;
  }

  if (await alreadyHandled(activity.id!)) return;

  const projectId = await resolveProjectForTenant(tenantId);
  if (!projectId) {
    console.warn('[teams-webhook] no project installed for tenant', { tenantId });
    return;
  }

  await createOrJoinTeamsConversationSession({
    projectId,
    tenantId,
    conversationId: activity.conversation!.id!,
    activity,
  });

  await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, new Date())).catch(() => {});
}
