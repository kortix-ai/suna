import { conversationRefForSession, finalizeTurn, loadTurn, markTurnReplied } from './turn';
import type { TeamsConversationRef } from './types';

export async function prepareWaitingTurn(sessionId: string, title: string): Promise<TeamsConversationRef | null> {
  const handle = await loadTurn(sessionId);
  let ref: TeamsConversationRef | null;
  if (handle) {
    await finalizeTurn(handle, { title, unfinished: true });
    // Kept as a replied-turn marker, so a `teams send` from this same run
    // after the card does not open a second one.
    await markTurnReplied(sessionId);
    ref = {
      serviceUrl: handle.serviceUrl,
      conversationId: handle.conversationId,
      botId: handle.botId,
      fromId: handle.fromId,
      tenantId: handle.tenantId,
      projectId: handle.projectId,
    };
  } else {
    // A prompt that runs without a card of its own — a message sent while
    // another run was going, a queued start — still asks in its conversation.
    ref = await conversationRefForSession(sessionId);
  }
  return ref;
}
