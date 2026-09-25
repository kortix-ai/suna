import { notifyProjectAccessRequestManagers } from '../../projects/lib/access-requests';
import { sendCard, updateCard } from '../teams-api';
import { buildConnectAccountCard, buildRequestAccessCard } from './cards';
import { buildTeamsLoginUrl } from './login';
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
    const loginUrl = buildTeamsLoginUrl({
      tenantId: input.tenantId,
      teamsUserId: userId,
      ...(pendingId ? { pendingId } : {}),
    });
    await post(buildConnectAccountCard(loginUrl));
    return;
  }
  await post(buildRequestAccessCard(input.projectId));
}

export async function notifyAdminsOfTeamsAccessRequest(input: {
  projectId: string;
  accountId: string;
  requesterUserId: string;
}): Promise<void> {
  await notifyProjectAccessRequestManagers({
    accountId: input.accountId,
    projectId: input.projectId,
    requesterUserId: input.requesterUserId,
  }).catch((err) => console.warn('[teams-auth] notify managers failed', err));
}
