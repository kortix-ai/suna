import { lt } from 'drizzle-orm';
import { chatEventDedup } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
import { sendCard } from '../teams-api';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { resolveConversationProjectDetailed } from './binding';
import { buildProjectPickerCard, buildWelcomeCard } from './cards';
import { createPendingTeamsPickerMessage } from './auth-resume';
import { sendCard as sendTeamsCard } from '../teams-api';
import { handleTeamsCommand, parseTeamsCommand } from './commands';
import { createOrJoinTeamsConversationSession, hasConversationSession } from './session';
import { MANAGED_TEAMS_INBOUND, conversationProjectFor, type TeamsInbound } from './inbound';
import type { TeamsActivity } from './types';
import { conversationScope, isBotMentioned } from './util';

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

export async function handleTeamsConversationUpdate(
  activity: TeamsActivity,
  inbound: TeamsInbound = MANAGED_TEAMS_INBOUND,
): Promise<void> {
  if (!botWasAdded(activity)) return;
  const tenantId = tenantOf(activity);
  const conversationId = activity.conversation?.id;
  if (!tenantId || !conversationId || !activity.serviceUrl) return;
  if (await alreadyHandled(`welcome:${conversationId}`)) return;

  const projectId = await conversationProjectFor(inbound, tenantId, conversationId);
  if (!projectId) return;
  if (!(await projectFeatureFlagEnabled(projectId, 'teams'))) return;

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

export async function handleTeamsActivity(
  activity: TeamsActivity,
  inbound: TeamsInbound = MANAGED_TEAMS_INBOUND,
): Promise<void> {
  if (activity.type === 'conversationUpdate' || activity.type === 'installationUpdate') {
    await handleTeamsConversationUpdate(activity, inbound);
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
  // A per-project (BYO) bot never resolves through the tenant's other installs:
  // it runs its own project, or nothing.
  const scopedProjectId =
    inbound.kind === 'project' ? await conversationProjectFor(inbound, tenantId, conversationId) : null;
  if (inbound.kind === 'project' && !scopedProjectId) {
    console.warn('[teams-webhook] conversation is bound to another project — ignoring', {
      projectId: inbound.projectId,
    });
    return;
  }
  const resolution = scopedProjectId
    ? ({ kind: 'project', projectId: scopedProjectId } as const)
    : await resolveConversationProjectDetailed(tenantId, conversationId);
  if (resolution.kind === 'none') {
    console.warn('[teams-webhook] no project installed for tenant', { tenantId });
    return;
  }
  if (resolution.kind === 'ambiguous') {
    // Several projects, nothing bound: ask rather than silently pick the first
    // install (the Slack behaviour). A command still runs against the first
    // install so `/projects` / `/use` work here; a task is parked and replayed
    // when the user picks.
    const command = parseTeamsCommand(activity.text);
    if (command) {
      await handleTeamsCommand({ command, activity, tenantId, projectId: resolution.projects[0].projectId });
      return;
    }
    if (activity.serviceUrl) {
      const pendingId = await createPendingTeamsPickerMessage({ tenantId, teamsUserId: activity.from?.id ?? '', activity });
      await sendTeamsCard(
        {
          serviceUrl: activity.serviceUrl,
          conversationId,
          botId: activity.recipient?.id,
          fromId: activity.from?.id,
          tenantId,
        },
        buildProjectPickerCard(resolution.projects, pendingId),
      ).catch((err) => console.warn('[teams-webhook] project picker failed', err));
    }
    return;
  }
  const projectId = resolution.projectId;
  // Per-project gate — the `teams` feature flag. This is the only
  // enforcement point for the shared multi-tenant webhook, which cannot know
  // the project before this line.
  if (!(await projectFeatureFlagEnabled(projectId, 'teams'))) {
    console.warn('[teams-webhook] teams feature is off for project — ignoring', { projectId });
    return;
  }

  // With `ChannelMessage.Read.Group` (RSC) Teams delivers every channel
  // message, not only @-mentions. An un-mentioned message is a follow-up in a
  // thread the bot already owns — or nothing to us. It never starts a session
  // and never runs a command: that would make the bot answer to every line
  // typed in a channel it was added to.
  const ownThreadsOnly = inbound.kind === 'project';
  if (conversationScope(activity) !== 'personal' && !isBotMentioned(activity)) {
    if (!(await hasConversationSession(tenantId, conversationId, ownThreadsOnly ? projectId : undefined))) return;
    await createOrJoinTeamsConversationSession({ projectId, tenantId, conversationId, activity, ownThreadsOnly });
    await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, new Date())).catch(() => {});
    return;
  }

  const command = parseTeamsCommand(activity.text);
  if (command) {
    await handleTeamsCommand({ command, activity, tenantId, projectId, projectScoped: ownThreadsOnly });
    await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, new Date())).catch(() => {});
    return;
  }

  await createOrJoinTeamsConversationSession({ projectId, tenantId, conversationId, activity, ownThreadsOnly });

  await db.delete(chatEventDedup).where(lt(chatEventDedup.expiresAt, new Date())).catch(() => {});
}
