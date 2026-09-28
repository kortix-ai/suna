import { sendCard } from '../teams-api';
import { buildTeamsApprovalCard } from './cards';
import { conversationRefForSession, finalizeTurn, loadTurn, markTurnReplied } from './turn';
import type { TeamsConversationRef } from './types';

/**
 * Post the approval card for a gated connector call into the session's Teams
 * conversation. Resolves the posted activity id, or null when the session has
 * no Teams conversation or the post failed.
 */
export async function postTeamsApprovalCard(
  sessionId: string,
  card: Parameters<typeof buildTeamsApprovalCard>[0],
): Promise<{ activityId: string; ref: TeamsConversationRef } | null> {
  const handle = await loadTurn(sessionId);
  const ref: TeamsConversationRef | null = handle
    ? {
        serviceUrl: handle.serviceUrl,
        conversationId: handle.conversationId,
        botId: handle.botId,
        fromId: handle.fromId,
        tenantId: handle.tenantId,
        projectId: handle.projectId,
      }
    : await conversationRefForSession(sessionId);
  if (!ref) return null;
  const activityId = await sendCard(ref, buildTeamsApprovalCard(card));
  if (!activityId) return null;
  // The agent now waits on a human: close the in-flight plan the way a review
  // card does, and mark the turn replied so a later `teams send` from the
  // same run does not open a second card.
  if (handle) {
    await finalizeTurn(handle, { title: 'Waiting for your decision', unfinished: true });
    await markTurnReplied(sessionId);
  }
  return { activityId, ref };
}
