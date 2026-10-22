import { sendCard, sendTargetedCard } from '../teams-api';
import type { TeamsActivity, TeamsConversationRef } from './types';
import { isPersonalChat } from './util';

/**
 * A card for one person in a channel or group chat: a targeted message only
 * `recipientId` (`29:…`) sees, as Slack's ephemeral. With no recipient, or
 * when Teams refuses the targeted message, the card goes to the whole
 * conversation, as every card did before Teams had targeted messages. So a
 * card that only that person may see (the sign-in link) never comes here:
 * login-card.ts sends it.
 */
export async function sendCardPrivately(
  ref: TeamsConversationRef,
  recipientId: string | null | undefined,
  card: unknown,
): Promise<string | null> {
  if (recipientId) {
    const id = await sendTargetedCard(ref, recipientId, card);
    if (id) return id;
  }
  return sendCard(ref, card);
}

/** Answer the sender of `activity` alone. A one-to-one chat is private already. */
export function replyPrivately(ref: TeamsConversationRef, activity: TeamsActivity, card: unknown): Promise<string | null> {
  return sendCardPrivately(ref, isPersonalChat(activity) ? null : activity.from?.id, card);
}
