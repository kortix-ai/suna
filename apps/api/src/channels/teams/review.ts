import { config } from '../../config';
import { sendCard, sendText } from '../teams-api';
import { buildReviewCard } from './cards';
import { conversationRefForSession, finalizeTurn, loadTurn, markTurnReplied } from './turn';
import type { ReviewCardItem } from '../slack/review-cards';
import type { TeamsConversationRef } from './types';

export async function postTeamsReviewCard(
  sessionId: string,
  item: ReviewCardItem,
): Promise<{ ok: boolean; error?: string }> {
  const handle = await loadTurn(sessionId);
  let ref: TeamsConversationRef | null;
  if (handle) {
    // NOT "Task complete". The agent did not finish — it is waiting for a
    // decision. Same mistake the question path carried: the default title sat
    // one line above a card asking the user to approve or deny something.
    await finalizeTurn(handle, { title: 'Waiting for your decision', unfinished: true });
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
    // A review filed by a prompt with no card of its own (a follow-up, a
    // queued start) still reaches the conversation the session owns.
    ref = await conversationRefForSession(sessionId);
    if (!ref) return { ok: false, error: 'No active Teams turn for this session.' };
  }
  const viewUrl = ref.projectId
    ? `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/projects/${ref.projectId}/review`
    : undefined;

  const posted = await sendCard(
    ref,
    buildReviewCard({
      reviewItemId: item.review_item_id,
      title: item.title,
      summary: item.summary,
      risk: item.risk,
      viewUrl,
    }),
  );
  if (posted) return { ok: true };

  // The turn is already closed and deleted, so a rejected card leaves the user
  // looking at "Waiting for your decision" with nothing to decide on. The
  // question path has always fallen back to text for exactly this; the review
  // path did not, and lost the review outright. The buttons are gone, but the
  // decision can still be made in Kortix or stated as a reply.
  const plain = [
    `**${item.title}**`,
    item.summary,
    item.risk && item.risk !== 'none' ? `Risk · ${item.risk}` : '',
    viewUrl ? `[Review it in Kortix ↗](${viewUrl})` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const fallback = await sendText(ref, plain);
  return fallback ? { ok: true } : { ok: false, error: 'Failed to post the review card to Teams.' };
}
