import { config } from '../../config';
import { latestPendingTeamsAuthMessageId } from './auth-resume';
import { buildConnectAccountCard, buildConnectPrivatelyCard, buildConnectSentPrivatelyCard } from './cards';
import { openDirectConversation, sendCard } from '../teams-api';
import { buildTeamsLoginUrl } from './login';
import type { TeamsActivity } from './types';
import { isPersonalChat } from './util';

/**
 * The card that asks a Teams user to connect their Kortix account.
 *
 * The sign-in link links the Teams user it names to whoever opens it
 * (identity-routes.ts `/bind`), so it is shown only in a one-to-one chat with
 * the bot. In a channel or group chat everyone sees the card, so there it says
 * to open a private chat and send `/login`. Until 2026-09-28 the link was
 * posted in every conversation: anyone who saw it within its 10 minutes could
 * link that person's Teams identity to their own Kortix account, and that
 * person's messages would then run as them.
 *
 * Outside a 1:1 chat the bot first tries to send the link to the person's 1:1
 * chat itself, as Slack DMs its connect prompt. Teams allows that only when the
 * person has the app installed for themselves; otherwise the card says where
 * to go instead.
 */
export async function teamsLoginCard(input: {
  activity: TeamsActivity;
  tenantId: string;
  teamsUserId: string;
  /** The message parked for this user, when the prompt answers one. */
  pendingId?: string | null;
  /** The project whose bot and service URL open the 1:1 chat. */
  projectId?: string;
}): Promise<Record<string, unknown>> {
  const connectCard = async () => {
    const pendingId =
      input.pendingId ??
      (await latestPendingTeamsAuthMessageId({ tenantId: input.tenantId, teamsUserId: input.teamsUserId }));
    return buildConnectAccountCard(
      buildTeamsLoginUrl({
        tenantId: input.tenantId,
        teamsUserId: input.teamsUserId,
        ...(pendingId ? { pendingId } : {}),
      }),
    );
  };
  if (isPersonalChat(input.activity)) return connectCard();
  const botName = input.activity.recipient?.name?.trim() || config.TEAMS_APP_NAME || 'Kortix';
  const direct = input.projectId && input.teamsUserId
    ? await openDirectConversation({ projectId: input.projectId, tenantId: input.tenantId, userId: input.teamsUserId })
    : null;
  if (direct && (await sendCard(direct, await connectCard()))) {
    return buildConnectSentPrivatelyCard({ botName, resumes: Boolean(input.pendingId) });
  }
  return buildConnectPrivatelyCard({
    chatUrl: botChatUrl(input.activity.recipient?.id),
    botName,
    resumes: Boolean(input.pendingId),
  });
}

/** A Teams deep link that opens a one-to-one chat with the bot, whose id is `28:<app id>`. */
export function botChatUrl(botId: string | undefined): string | null {
  if (!botId?.startsWith('28:')) return null;
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(botId)}`;
}
