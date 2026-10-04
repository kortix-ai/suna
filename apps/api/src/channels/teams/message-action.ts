import { config } from '../../lib/config';
import { sessionWebUrl } from '../slack/util';
import { conversationSession } from './binding';
import { buildOpenSessionCard } from './cards';
import { conversationProjectFor, type TeamsInbound } from './inbound';
import type { TeamsActivity } from './types';

/** The message action's command id (teams-manifest.ts `composeExtensions`). */
export const OPEN_IN_KORTIX_COMMAND = 'openInKortix';

interface MessageActionValue {
  commandId?: string;
  messagePayload?: { id?: string; replyToId?: string };
}

/**
 * The conversation ids a message's session can live under. A channel keeps one
 * session per thread, keyed `19:…@thread.tacv2;messageid=<root>`; an invoke
 * from a channel message may carry the bare channel id, so the thread root
 * (the message's parent, or the message itself) completes it.
 */
export function sessionConversationIds(conversationId: string, value: MessageActionValue): string[] {
  if (conversationId.includes(';messageid=')) return [conversationId];
  const root = value.messagePayload?.replyToId || value.messagePayload?.id;
  return root ? [conversationId, `${conversationId};messageid=${root}`] : [conversationId];
}

/**
 * "Open in Kortix" on any message: the session behind that conversation, as
 * Slack's message shortcut answers. The answer is a small dialog with the link;
 * opening the session still needs access to it in Kortix.
 */
export async function handleOpenInKortixAction(activity: TeamsActivity, inbound: TeamsInbound): Promise<unknown> {
  const value = (activity.value ?? {}) as MessageActionValue;
  if (value.commandId !== OPEN_IN_KORTIX_COMMAND) return taskMessage("This action isn't available.");
  const tenantId = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
  const conversationId = activity.conversation?.id;
  if (!tenantId || !conversationId) return taskMessage("I couldn't read that message's conversation.");

  for (const id of sessionConversationIds(conversationId, value)) {
    const projectId = await conversationProjectFor(inbound, tenantId, id);
    if (!projectId) continue;
    const session = await conversationSession(tenantId, id, inbound.kind === 'project' ? inbound.projectId : undefined);
    if (!session) continue;
    return taskCard(buildOpenSessionCard(sessionWebUrl(config.FRONTEND_URL, projectId, session.sessionId)));
  }
  return taskMessage('No Kortix session is attached to this conversation yet. @-mention me to start one.');
}

function taskMessage(text: string) {
  return { task: { type: 'message', value: text } };
}

function taskCard(card: Record<string, unknown>) {
  return {
    task: {
      type: 'continue',
      value: {
        title: 'Kortix',
        height: 'small',
        width: 'small',
        card: { contentType: 'application/vnd.microsoft.card.adaptive', content: card },
      },
    },
  };
}
