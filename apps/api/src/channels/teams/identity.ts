import { config } from '../../config';
import { accountRoleMap, isAccountManagerRole } from '../../iam/read-models';
import { notifyProjectAccessRequestManagers } from '../../projects/lib/access-requests';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { lookupChatUserForKortixUser } from '../core/identity';
import { openDirectConversation, sendCard, updateCard } from '../teams-api';
import { buildAccessRequestNoticeCard, buildConnectedCard, buildRequestAccessCard } from './cards';
import { teamsLoginCard } from './login-card';
import { createPendingTeamsAuthMessage } from './auth-resume';
import type { TeamsActivity, TeamsConversationRef } from './types';

// The Teams rendering of the chat identity link (core/identity.ts owns the
// link itself and the actor check).

export function teamsUserId(activity: TeamsActivity): string | null {
  return activity.from?.aadObjectId ?? activity.from?.id ?? null;
}

function conversationRef(activity: TeamsActivity, projectId?: string): TeamsConversationRef | null {
  if (!activity.serviceUrl || !activity.conversation?.id) return null;
  return {
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    tenantId: activity.conversation.tenantId ?? activity.channelData?.tenant?.id,
    projectId,
  };
}

export async function postTeamsIdentityPrompt(input: {
  projectId: string;
  tenantId: string;
  activity: TeamsActivity;
  reason: 'unlinked' | 'not_member';
  /** The live "Working on it…" card to replace, when one was already posted. */
  replaceActivityId?: string;
}): Promise<void> {
  const ref = conversationRef(input.activity, input.projectId);
  if (!ref) return;
  const userId = teamsUserId(input.activity);
  if (!userId) return;

  const post = async (card: Record<string, unknown>) => {
    if (input.replaceActivityId && (await updateCard(ref, input.replaceActivityId, card))) return;
    await sendCard(ref, card);
  };

  if (input.reason === 'unlinked') {
    const pendingId = await createPendingTeamsAuthMessage({
      projectId: input.projectId,
      tenantId: input.tenantId,
      teamsUserId: userId,
      activity: input.activity,
    });
    // The sign-in link only in a one-to-one chat (login-card.ts).
    await post(await teamsLoginCard({ activity: input.activity, tenantId: input.tenantId, teamsUserId: userId, pendingId, projectId: input.projectId }));
    return;
  }
  await post(buildRequestAccessCard(input.projectId));
}

/**
 * Tell the account's admins that someone asked for access. The notice every
 * manager gets in Kortix goes first. Then each admin who linked Teams in this
 * tenant gets a card in their 1:1 chat with the bot, as Slack DMs its admins.
 * Best effort: Teams opens that chat only for an admin with the app installed
 * personally, and the Kortix notice already covers everyone else.
 */
export async function notifyAdminsOfTeamsAccessRequest(input: {
  tenantId: string;
  projectId: string;
  accountId: string;
  requesterUserId: string;
}): Promise<void> {
  await notifyProjectAccessRequestManagers({
    accountId: input.accountId,
    projectId: input.projectId,
    requesterUserId: input.requesterUserId,
  }).catch((err) => console.warn('[teams-auth] notify managers failed', err));

  try {
    const admins = [...(await accountRoleMap(input.accountId)).entries()]
      .filter(([userId, role]) => isAccountManagerRole(role) && userId !== input.requesterUserId)
      .map(([userId]) => userId);
    if (admins.length === 0) return;
    const email = (await lookupEmailsByUserIds([input.requesterUserId]).catch(() => null))?.get(input.requesterUserId);
    const notice = buildAccessRequestNoticeCard({
      requester: email ? `**${email}**` : 'A teammate',
      reviewUrl: `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/projects/${input.projectId}/customize/members`,
    });
    for (const admin of admins) {
      const teamsId = await lookupChatUserForKortixUser('teams', input.tenantId, admin);
      if (!teamsId) continue;
      const direct = await openDirectConversation({ projectId: input.projectId, tenantId: input.tenantId, userId: teamsId });
      if (direct) await sendCard(direct, notice);
    }
  } catch (err) {
    console.warn('[teams-auth] admin access-request notice failed', { err: (err as Error)?.message });
  }
}

/**
 * After `/login` completes in the browser: say so in the person's 1:1 chat,
 * where the sign-in link was sent. Slack posts "Slack connected — picking up
 * your message". Best effort: Teams opens the chat only when the app is
 * installed for them.
 */
export async function confirmTeamsConnected(input: {
  projectId: string;
  tenantId: string;
  teamsUserId: string;
  userId: string;
  resumed: boolean;
  hasAccess: boolean;
}): Promise<void> {
  try {
    const direct = await openDirectConversation({ projectId: input.projectId, tenantId: input.tenantId, userId: input.teamsUserId });
    if (!direct) return;
    const email = (await lookupEmailsByUserIds([input.userId]).catch(() => null))?.get(input.userId) ?? null;
    await sendCard(direct, buildConnectedCard({ email, resumed: input.resumed, hasAccess: input.hasAccess, projectId: input.projectId }));
  } catch (err) {
    console.warn('[teams-auth] connected confirmation failed', { err: (err as Error)?.message });
  }
}
