import { lt } from 'drizzle-orm';
import { chatEventDedup } from '@kortix/db';
import { db } from '../../shared/db';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { resolveConversationProject } from './binding';
import { handleTeamsCommand, parseTeamsCommand } from './commands';
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

export async function handleTeamsActivity(activity: TeamsActivity): Promise<void> {
  if (!isActionableMessage(activity)) return;

  const tenantId = tenantOf(activity);
  if (!tenantId) {
    console.warn('[teams-webhook] activity has no tenant — ignoring', { activityId: activity.id });
    return;
  }

  if (await alreadyHandled(activity.id!)) return;

  const conversationId = activity.conversation!.id!;
  const projectId = await resolveConversationProject(tenantId, conversationId);
  if (!projectId) {
    console.warn('[teams-webhook] no project installed for tenant', { tenantId });
    return;
  }

  const command = parseTeamsCommand(activity.text);
  if (command) {
    await handleTeamsCommand({ command, activity, tenantId, projectId });
    await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, new Date())).catch(() => {});
    return;
  }

  await createOrJoinTeamsConversationSession({ projectId, tenantId, conversationId, activity });

  await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, new Date())).catch(() => {});
}
