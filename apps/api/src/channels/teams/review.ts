import { config } from '../../config';
import { sendCard, sendText } from '../teams-api';
import { buildReviewCard } from './cards';
import { prepareWaitingTurn } from './waiting-turn';
import type { ReviewCardItem } from '../slack/review-cards';

export async function postTeamsReviewCard(
  sessionId: string,
  item: ReviewCardItem,
): Promise<{ ok: boolean; error?: string }> {
    // NOT "Task complete". The agent did not finish — it is waiting for a
    // decision. Same mistake the question path carried: the default title sat
    // one line above a card asking the user to approve or deny something.
    // A review filed by a prompt with no card of its own (a follow-up, a
    // queued start) still reaches the conversation the session owns.
  const ref = await prepareWaitingTurn(sessionId, 'Waiting for your decision');
  if (!ref) return { ok: false, error: 'No active Teams turn for this session.' };
  const viewUrl = ref.projectId
    ? `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/workspaces/${ref.projectId}/review`
    : undefined;

  const posted = await sendCard(
    ref,
    buildReviewCard({
      reviewItemId: item.review_item_id,
      title: item.title,
      summary: item.summary,
      risk: item.risk,
      viewUrl,
      kind: item.kind,
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
