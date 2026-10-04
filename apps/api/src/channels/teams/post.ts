import { and, eq } from 'drizzle-orm';
import { chatChannelBindings } from '@kortix/db';
import { db } from '../../lib/db';
import { loadTeamsServiceUrlForProject } from '../install-store';
import { deleteActivity, sendActivity, sendCard, updateCard } from '../teams-api';
import { buildNoticeCard, withoutPostbackActions } from './cards';
import type { TeamsConversationRef } from './types';

/**
 * Proactive posting — the Teams twin of Slack's `send_message`, which lets an
 * agent post into a channel it is not currently answering in (a nightly
 * summary, an alert, a hand-off note).
 *
 * The conversation is NOT addressed by a caller-supplied service URL. It is
 * looked up in `chat_channel_bindings`, which only
 * `ensureTeamsConversationBinding` writes and only after confirming the tenant
 * has an install for that project. So an agent can reach exactly the
 * conversations its own project is already bound to, and nothing else in the
 * tenant. Without that gate, `conversation_id` would be an open address on the
 * bot's tenant-wide credential — the same shape as the team-drive write that
 * had to be fixed in the upload path (CWE-862).
 */

export type TeamsPostError = { ok: false; error: string; status: number };
/** `messageId` is the Teams activity id: what `editTeamsMessage` and `deleteTeamsMessage` take. */
export type TeamsPostResult = { ok: true; conversationId: string; delivered: 'text' | 'card'; messageId: string };

/** Conversations this project may post into, for the agent to choose from. */
export async function listTeamsPostTargets(
  projectId: string,
): Promise<Array<{ conversationId: string; name: string | null; type: string | null }>> {
  const rows = await db
    .select({
      channelId: chatChannelBindings.channelId,
      channelName: chatChannelBindings.channelName,
      channelType: chatChannelBindings.channelType,
    })
    .from(chatChannelBindings)
    .where(and(eq(chatChannelBindings.platform, 'teams'), eq(chatChannelBindings.projectId, projectId)));
  return rows.map((r) => ({
    conversationId: r.channelId,
    name: r.channelName ?? null,
    type: r.channelType ?? null,
  }));
}

/** A conversation this project may send into, addressed as the server knows it. */
export interface TeamsProjectConversation {
  ok: true;
  ref: TeamsConversationRef;
  /** `channel` | `groupChat` | `personal`, as the binding recorded it; null when unknown. */
  conversationType: string | null;
}

/**
 * The conversation `conversationId` names, as THIS project may address it.
 *
 * Every send into a conversation goes through here: proactive posts and file
 * uploads. The binding row proves the project already talks there; the tenant
 * comes from that row, and the service URL is the one inbound activities
 * stored. Nothing about the address comes from the caller except the id, so a
 * caller can neither reach another project's conversation nor point the bot
 * token at a host of their own.
 */
export async function resolveTeamsProjectConversation(
  projectId: string,
  conversationId: string,
): Promise<TeamsProjectConversation | TeamsPostError> {
  // THE AUTHORIZATION. A binding row exists only for a conversation this
  // project was already talking in; the tenant is read from the row rather
  // than from the caller.
  const [binding] = await db
    .select({ workspaceId: chatChannelBindings.workspaceId, channelType: chatChannelBindings.channelType })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, 'teams'),
        eq(chatChannelBindings.channelId, conversationId),
        eq(chatChannelBindings.projectId, projectId),
      ),
    )
    .limit(1);
  if (!binding) {
    // 404, not 403. A 403 on these routes means the CALLER may not send at all
    // (the `project.connector.write` gate, matching the Slack upload twin and
    // flow CHN-20). "This project has no such conversation" is an addressing
    // answer, and keeping the two apart is what makes a test of either one
    // meaningful.
    return {
      ok: false,
      error:
        'This project has no such Teams conversation. Post only to a chat or channel the bot is already in — `teams conversations` lists them.',
      status: 404,
    };
  }

  const serviceUrl = await loadTeamsServiceUrlForProject(projectId);
  if (!serviceUrl) {
    return { ok: false, error: 'No Teams service URL is known yet for this project', status: 409 };
  }

  return {
    ok: true,
    ref: { serviceUrl, conversationId, tenantId: binding.workspaceId, projectId },
    conversationType: binding.channelType ?? null,
  };
}

export async function postToTeamsConversation(
  projectId: string,
  args: { conversationId: string; text?: string; card?: Record<string, unknown> },
): Promise<TeamsPostResult | TeamsPostError> {
  const conversationId = args.conversationId?.trim();
  if (!conversationId) return { ok: false, error: 'conversation_id is required', status: 400 };
  const text = args.text?.trim();
  if (!text && !args.card) return { ok: false, error: 'text or card is required', status: 400 };

  const conversation = await resolveTeamsProjectConversation(projectId, conversationId);
  if (!conversation.ok) return conversation;
  const { ref } = conversation;

  if (args.card) {
    const posted = await sendCard(ref, withoutPostbackActions(args.card));
    if (!posted) return { ok: false, error: 'Teams refused the card', status: 502 };
    return { ok: true, conversationId, delivered: 'card', messageId: posted };
  }

  // Markdown lands as a notice card so a proactive post reads like every other
  // Kortix message in the conversation instead of raw text.
  const posted = await sendCard(ref, buildNoticeCard(text!));
  if (posted) return { ok: true, conversationId, delivered: 'card', messageId: posted };

  const plain = await sendActivity(ref, { type: 'message', text: text! });
  if (!plain) return { ok: false, error: 'Teams refused the message', status: 502 };
  return { ok: true, conversationId, delivered: 'text', messageId: plain };
}

/**
 * Replace a message the bot posted (`postToTeamsConversation`'s `messageId`),
 * as `slack edit` does. The conversation is authorized exactly as a post is;
 * Bot Framework itself refuses a message the bot did not send.
 */
export async function editTeamsMessage(
  projectId: string,
  args: { conversationId: string; messageId: string; text?: string; card?: Record<string, unknown> },
): Promise<{ ok: true; conversationId: string; messageId: string } | TeamsPostError> {
  const conversationId = args.conversationId?.trim();
  const messageId = args.messageId?.trim();
  if (!conversationId || !messageId) return { ok: false, error: 'conversation_id and message_id are required', status: 400 };
  const text = args.text?.trim();
  if (!text && !args.card) return { ok: false, error: 'text or card is required', status: 400 };
  const conversation = await resolveTeamsProjectConversation(projectId, conversationId);
  if (!conversation.ok) return conversation;
  const updated = await updateCard(conversation.ref, messageId, args.card ? withoutPostbackActions(args.card) : buildNoticeCard(text!));
  if (!updated) return { ok: false, error: 'Teams refused the edit. Only a message this bot posted can be edited.', status: 502 };
  return { ok: true, conversationId, messageId };
}

/** Delete a message the bot posted, as `slack delete` does. */
export async function deleteTeamsMessage(
  projectId: string,
  args: { conversationId: string; messageId: string },
): Promise<{ ok: true; conversationId: string; messageId: string } | TeamsPostError> {
  const conversationId = args.conversationId?.trim();
  const messageId = args.messageId?.trim();
  if (!conversationId || !messageId) return { ok: false, error: 'conversation_id and message_id are required', status: 400 };
  const conversation = await resolveTeamsProjectConversation(projectId, conversationId);
  if (!conversation.ok) return conversation;
  if (!(await deleteActivity(conversation.ref, messageId))) {
    return { ok: false, error: 'Teams refused the delete. Only a message this bot posted can be deleted.', status: 502 };
  }
  return { ok: true, conversationId, messageId };
}
