import { config } from '../../../lib/config';
import { latestPendingTeamsAuthMessageId } from './auth-resume';
import { buildConnectAccountCard, buildConnectPrivatelyCard, buildConnectSentPrivatelyCard } from './cards';
import { openDirectConversation, sendCard, sendTargetedCard, updateCard } from '../teams-api';
import { buildTeamsLoginUrl } from './login';
import type { TeamsActivity, TeamsConversationRef } from './types';
import { isPersonalChat } from './util';

/**
 * Ask a Teams user to connect their Kortix account.
 *
 * The sign-in link links the Teams user it names to whoever opens it
 * (identity-routes.ts `/bind`), so only that person may see it. Until
 * 2026-09-28 the link was posted in every conversation: anyone who saw it
 * within its 10 minutes could link that person's Teams identity to their own
 * Kortix account, and that person's messages would then run as them.
 *
 * - A one-to-one chat gets the card with the link.
 * - A channel or group chat gets it as a targeted message, which only that
 *   person sees, as Slack's ephemeral (2026-10-01: everyone used to see the
 *   card that sent them to a private chat).
 * - When Teams refuses the targeted message, the link goes to the person's
 *   1:1 chat, which Teams opens only when they have the app installed for
 *   themselves, and the conversation gets a card without the link that says
 *   where it went, or where to ask for it.
 */
export async function sendTeamsLoginPrompt(input: {
  ref: TeamsConversationRef;
  activity: TeamsActivity;
  tenantId: string;
  teamsUserId: string;
  /** The message parked for this user, when the prompt answers one. */
  pendingId?: string | null;
  /** This person's own "Working on it…" card in a 1:1 chat, which the prompt replaces. */
  replaceActivityId?: string;
}): Promise<void> {
  const { ref, activity } = input;
  if (!input.teamsUserId) return;
  const pendingId =
    input.pendingId ??
    (await latestPendingTeamsAuthMessageId({ tenantId: input.tenantId, teamsUserId: input.teamsUserId }));
  const connectCard = buildConnectAccountCard(
    buildTeamsLoginUrl({
      tenantId: input.tenantId,
      teamsUserId: input.teamsUserId,
      ...(pendingId ? { pendingId } : {}),
    }),
    { resumes: Boolean(pendingId) },
  );
  const post = async (card: Record<string, unknown>) => {
    if (input.replaceActivityId && (await updateCard(ref, input.replaceActivityId, card))) return;
    await sendCard(ref, card);
  };

  if (isPersonalChat(activity)) return post(connectCard);
  if (activity.from?.id && (await sendTargetedCard(ref, activity.from.id, connectCard))) return;

  const botName = activity.recipient?.name?.trim() || config.TEAMS_APP_NAME || 'Kortix';
  const resumes = Boolean(input.pendingId);
  const direct = ref.projectId
    ? await openDirectConversation({ projectId: ref.projectId, tenantId: input.tenantId, userId: input.teamsUserId })
    : null;
  if (direct && (await sendCard(direct, connectCard))) {
    return post(buildConnectSentPrivatelyCard({ botName, resumes }));
  }
  return post(buildConnectPrivatelyCard({ chatUrl: botChatUrl(activity.recipient?.id), botName, resumes }));
}

/** A Teams deep link that opens a one-to-one chat with the bot, whose id is `28:<app id>`. */
export function botChatUrl(botId: string | undefined): string | null {
  if (!botId?.startsWith('28:')) return null;
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(botId)}`;
}
