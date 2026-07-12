import { lt } from 'drizzle-orm';
import { chatEventDedup } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { sendCard } from '../teams-api';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { resolveConversationProject } from './binding';
import { buildWelcomeCard } from './cards';
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

function botWasAdded(activity: TeamsActivity): boolean {
  const botId = activity.recipient?.id;
  if (activity.type === 'installationUpdate') return activity.action === 'add';
  if (activity.type === 'conversationUpdate') {
    return Boolean(botId && activity.membersAdded?.some((m) => m.id === botId));
  }
  return false;
}

export async function handleTeamsConversationUpdate(activity: TeamsActivity): Promise<void> {
  if (!botWasAdded(activity)) return;
  const tenantId = tenantOf(activity);
  const conversationId = activity.conversation?.id;
  if (!tenantId || !conversationId || !activity.serviceUrl) return;
  if (await alreadyHandled(`welcome:${conversationId}`)) return;

  const projectId = await resolveConversationProject(tenantId, conversationId);
  if (!projectId) return;

  const projectUrl = `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/projects/${projectId}`;
  await sendCard(
    {
      serviceUrl: activity.serviceUrl,
      conversationId,
      botId: activity.recipient?.id,
      fromId: activity.from?.id,
      tenantId,
      projectId,
    },
    buildWelcomeCard({ projectUrl }),
  );
}

export async function handleTeamsActivity(activity: TeamsActivity): Promise<void> {
  if (activity.type === 'conversationUpdate' || activity.type === 'installationUpdate') {
    await handleTeamsConversationUpdate(activity);
    return;
  }
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
