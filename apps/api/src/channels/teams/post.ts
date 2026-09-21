import { and, eq } from 'drizzle-orm';
import { chatChannelBindings } from '@kortix/db';
import { db } from '../../shared/db';
import { loadTeamsServiceUrlForProject } from '../install-store';
import { sendActivity, sendCard } from '../teams-api';
import { buildNoticeCard } from './cards';
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
export type TeamsPostResult = { ok: true; conversationId: string; delivered: 'text' | 'card' };

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

export async function postToTeamsConversation(
  projectId: string,
  args: { conversationId: string; text?: string; card?: Record<string, unknown> },
): Promise<TeamsPostResult | TeamsPostError> {
  const conversationId = args.conversationId?.trim();
  if (!conversationId) return { ok: false, error: 'conversation_id is required', status: 400 };
  const text = args.text?.trim();
  if (!text && !args.card) return { ok: false, error: 'text or card is required', status: 400 };

  // THE AUTHORIZATION. A binding row exists only for a conversation this
  // project was already talking in; the tenant is read from the row rather
  // than from the caller.
  const [binding] = await db
    .select({ workspaceId: chatChannelBindings.workspaceId })
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
    // 404, not 403. A 403 on this route means the CALLER may not post at all
    // (the `project.connector.write` gate above, matching the Slack upload
    // twin and flow CHN-20). "This project has no such conversation" is an
    // addressing answer, and keeping the two apart is what makes a test of
    // either one meaningful.
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

  const ref: TeamsConversationRef = {
    serviceUrl,
    conversationId,
    tenantId: binding.workspaceId,
    projectId,
  };

  if (args.card) {
    const posted = await sendCard(ref, args.card);
    if (!posted) return { ok: false, error: 'Teams refused the card', status: 502 };
    return { ok: true, conversationId, delivered: 'card' };
  }

  // Markdown lands as a notice card so a proactive post reads like every other
  // Kortix message in the conversation instead of raw text.
  const posted = await sendCard(ref, buildNoticeCard(text!));
  if (posted) return { ok: true, conversationId, delivered: 'card' };

  const plain = await sendActivity(ref, { type: 'message', text: text! });
  if (!plain) return { ok: false, error: 'Teams refused the message', status: 502 };
  return { ok: true, conversationId, delivered: 'text' };
}
